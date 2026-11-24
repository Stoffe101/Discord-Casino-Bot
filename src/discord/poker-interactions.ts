import type { ButtonInteraction, ModalSubmitInteraction, RepliableInteraction } from 'discord.js';
import type { CasinoApp } from '../app/casino-app.js';
import { StaleActionError, UserError } from '../core/errors.js';
import { parseChipAmount } from '../core/format.js';
import { pokerActions, type PokerAction } from '../games/poker/engine.js';
import { intArg, parseCid } from '../ui/custom-id.js';
import type { ModalSpec, Screen } from '../ui/kit.js';
import { noticeScreen, returnToCasino, type Viewer } from '../ui/screens/common.js';
import { joinPokerModal, openPokerModal, playerPokerScreen, pokerJoinedScreen, pokerRaiseModal } from '../ui/screens/poker.js';
import { tablesScreen } from '../ui/screens/blackjack.js';
import type { CasinoBot } from './bot.js';

interface PokerResponses {
  show(i: RepliableInteraction, screen: Screen): Promise<void>;
  modal(i: ButtonInteraction, modal: ModalSpec): Promise<void>;
  arm(i: RepliableInteraction): void;
}

const playerActions: Record<string, PokerAction['type']> = { check: 'check', call: 'call', fold: 'fold', allin: 'all-in', raise: 'raise' };

export class PokerInteractions {
  constructor(
    private readonly app: CasinoApp,
    private readonly bot: CasinoBot,
  ) {}

  private table(viewer: Viewer, id: string) {
    const table = this.app.poker.peek(id);
    if (!table || table.record.guildId !== viewer.guildId) throw new UserError('That Hold’em table has closed.');
    return table;
  }

  async component(i: ButtonInteraction, viewer: Viewer, ui: PokerResponses): Promise<void> {
    const { action, args } = parseCid(i.customId);
    if (action === 'create') {
      const settings = this.app.settings.get(viewer.guildId);
      if (!settings.enabled || !settings.poker.enabled) throw new UserError('Hold’em is closed on this server.');
      if (this.app.blackjack.tableOfUser(viewer.guildId, viewer.userId) || this.app.poker.tableOfUser(viewer.guildId, viewer.userId)) {
        ui.arm(i);
        return ui.show(i, tablesScreen(this.app, viewer, 'mine'));
      }
      return ui.modal(i, openPokerModal(this.app, viewer.guildId));
    }
    const [id = '', handId = '', seq = '', value = ''] = args;
    const table = this.table(viewer, id);
    const service = this.app.poker;
    if (action === 'join') {
      if (table.state.seats.some((seat) => seat.userId === viewer.userId)) {
        return ui.show(i, pokerJoinedScreen(table, table.record.ownerId === viewer.userId));
      }
      return ui.modal(i, joinPokerModal(table));
    }
    if (action === 'custom') {
      const hand = table.state.hand;
      const legal = hand ? pokerActions(hand, viewer.userId) : null;
      if (!hand || handId !== table.state.handId || intArg(seq, -1) !== hand.seq || !legal || legal.minTo === null) throw new StaleActionError('Refresh your poker hand.');
      return ui.modal(i, pokerRaiseModal(id, handId, hand.seq, legal.minTo, legal.maxTo));
    }
    ui.arm(i);
    if (action === 'start') {
      await service.start(id, viewer.userId, intArg(handId, -1), i);
      return ui.show(i, playerPokerScreen(this.table(viewer, id), viewer));
    }
    if (action === 'leave') {
      await service.leave(id, viewer.userId);
      const waiting = service.peek(id)?.state.seats.some((seat) => seat.userId === viewer.userId);
      return ui.show(i, noticeScreen({
        title: waiting ? 'Leaving after the hand' : 'Seat released',
        body: waiting ? 'Your stack returns to Wallet when the hand settles.' : 'Your remaining table chips were returned to Wallet.',
        buttons: [returnToCasino(this.app, viewer.guildId, table.record.channelId)],
      }));
    }
    if (action === 'close') {
      await service.close(id, 'closed by the host', viewer.userId);
      return ui.show(i, noticeScreen({ title: 'Table closed', body: 'Remaining stacks were returned to their wallets.', buttons: [returnToCasino(this.app, viewer.guildId, table.record.channelId)] }));
    }
    if (action === 'sit') {
      if (handId !== 'in' && handId !== 'out') throw new StaleActionError('Refresh your poker controls.');
      await service.sitOut(id, viewer.userId, handId === 'out');
    } else if (action !== 'hand') {
      const type = Object.hasOwn(playerActions, action) ? playerActions[action] : undefined;
      if (!type) throw new StaleActionError('Refresh your poker controls.');
      const move: PokerAction = type === 'raise' ? { type, to: intArg(value, -1) } : { type };
      await service.act(id, viewer.userId, handId, intArg(seq, -1), move, i);
    }
    return ui.show(i, playerPokerScreen(this.table(viewer, id), viewer));
  }

  async submit(
    i: ModalSubmitInteraction,
    viewer: Viewer,
    ui: PokerResponses,
    field: (id: string) => string,
    selection: (id: string) => string,
  ): Promise<void> {
    const { action, args } = parseCid(i.customId);
    ui.arm(i);
    const amount = (key: string) => {
      const parsed = parseChipAmount(field(key));
      if (parsed === null) throw new UserError('Enter a whole number of chips.');
      return parsed;
    };
    const service = this.app.poker;
    if (action === 'pkcreate') {
      const table = await service.create({
        guildId: viewer.guildId, userId: viewer.userId, name: viewer.displayName, tableName: field('name'),
        private: selection('visibility') === 'private', seats: intArg(field('seats'), -1), buyIn: amount('buyin'),
      });
      try {
        const { url } = await this.bot.createTablePanel(table.record.id, i.channelId, viewer.userId);
        if (!url) throw new Error('Missing poker panel');
      } catch {
        await service.close(table.record.id, 'Discord could not open the table');
        throw new UserError('The table could not be opened in Discord. Your buy-in was returned.');
      }
      return ui.show(i, pokerJoinedScreen(this.table(viewer, table.record.id), true));
    }
    const [id = '', handId = '', seq] = args;
    this.table(viewer, id);
    if (action === 'pkjoin') {
      await service.join(id, viewer.userId, viewer.displayName, amount('buyin'), field('code'));
      try {
        if (!await this.bot.addToTableThread(id, viewer.userId)) throw new Error('Missing poker panel');
      } catch {
        await service.leave(id, viewer.userId);
        throw new UserError('Discord could not open the table for you. Your stack will be returned.');
      }
      return ui.show(i, pokerJoinedScreen(this.table(viewer, id)));
    }
    if (action === 'pkraise') {
      await service.act(id, viewer.userId, handId, intArg(seq, -1), { type: 'raise', to: amount('amount') }, i);
      return ui.show(i, playerPokerScreen(this.table(viewer, id), viewer));
    }
    throw new StaleActionError('Refresh your poker controls.');
  }
}
