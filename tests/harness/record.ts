/**
 * Gameplay recorder (development only, no Discord connection).
 *
 * Plays short scripted sessions through the full bot stack (FakeDiscord) with the bot's REAL
 * animation timings and human-like pauses between clicks, records every message change, and
 * writes a Discord-styled HTML replay plus the frame images:
 *
 *   npm run record                    → recordings/<scenario>/index.html (+ frame PNGs, frames.md)
 *   npm run record -- blackjack slots
 *
 * Network latency to Discord is simulated (default 120 ms per request; --latency N).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_IN_DEAL_DELAY_MS } from '../../src/tables/blackjack-table-service.js';
import type { Card } from '../../src/games/cards.js';
import { CasinoHarness } from './casino-harness.js';
import { findComponents, type FakeUser, type TimelineEntry } from './fake-discord.js';

const args = process.argv.slice(2);
const num = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const LATENCY = num('latency', 120);
const THINK = num('think', 1400); // a player's pause before pressing a button
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Recording {
  name: string;
  title: string;
  start: number;
  entries: TimelineEntry[];
  focus: string | null; // message id of the main panel
  names: Map<string, string>;
}

async function session(name: string, title: string, play: (h: CasinoHarness, users: (n: string) => FakeUser) => Promise<string | null>): Promise<Recording> {
  const h = new CasinoHarness({ allowThreads: true, timing: 'real', seed: 9 });
  h.fd.latencyMs = LATENCY;
  h.fd.recording = true;
  const names = new Map<string, string>();
  const users = (n: string) => {
    const u = h.user(n);
    names.set(u.id, n);
    return u;
  };
  const start = Date.now();
  const focus = await play(h, users);
  await h.settle();
  const entries = [...h.fd.timeline];
  await h.close();
  return { name, title, start, entries, focus, names };
}

// ───────────────────────────── scenarios ─────────────────────────────

async function blackjack(h: CasinoHarness, users: (n: string) => FakeUser): Promise<string> {
  const [alex, hanna, oskar] = [users('Alex'), users('Hanna'), users('Oskar')];
  await h.click(alex, h.seen(await h.slash(alex, 'casino')), 'Play Blackjack');
  const tableId = h.app.blackjack.tableOfUser(h.guildId, alex.id)!.record.id;
  const panel = () => h.tablePanel(tableId);
  // Alex 8,8 (split) · Hanna 10,6 · Oskar 9,2 (double) · dealer 6 up, 10 hole; then draws.
  await h.app.blackjack.debugSetShoe(tableId, ['8S', 'TH', '9C', '6D', '8H', '6C', '2D', 'TS', '3C', '9H', '5S', '9D', 'KD', '4H'] as Card[]);
  await sleep(THINK);
  await h.click(alex, panel(), '100');
  await sleep(THINK / 2);
  await h.click(hanna, panel(), '25');
  await sleep(THINK / 2);
  await h.click(oskar, panel(), '100');
  await sleep(ALL_IN_DEAL_DELAY_MS);
  await h.advance(ALL_IN_DEAL_DELAY_MS);
  const act = async (who: FakeUser, label: string) => {
    await sleep(THINK);
    await h.click(who, panel(), label);
  };
  await act(alex, 'Split');
  await act(alex, 'Stand');
  await act(alex, 'Stand');
  await act(hanna, 'Hit');
  if (h.app.blackjack.peek(tableId)!.state.round?.turn && h.app.blackjack.peek(tableId)!.state.round!.seats[h.app.blackjack.peek(tableId)!.state.round!.turn!.seat]!.userId === hanna.id) await act(hanna, 'Stand');
  await act(oskar, 'Double');
  await h.settle();
  await sleep(2500); // let the results sit on screen
  return panel().id;
}

async function roulette(h: CasinoHarness, users: (n: string) => FakeUser): Promise<string> {
  const [alex, hanna] = [users('Alex'), users('Hanna')];
  const hub = h.seen(await h.click(alex, h.seen(await h.slash(alex, 'casino')), 'Games'))!;
  await h.click(alex, hub, 'Open the wheel');
  const record = h.app.roulette.wheelFor(h.guildId)!.record;
  const panel = () => h.fd.messages.get(h.app.roulette.peek(record.id)!.record.messageId!)!;
  const select = findComponents(panel().components, 3)[0]!;
  await sleep(THINK);
  await h.submit(alex, await h.select(alex, panel(), select.custom_id, ['red']), { amount: '50' });
  await sleep(THINK);
  await h.submit(hanna, await h.select(hanna, panel(), select.custom_id, ['straight']), { number: '17', amount: '20' });
  await sleep(THINK);
  await h.advance(h.app.settings.get(h.guildId).roulette.bettingSeconds * 1000 + 500);
  await h.app.roulette.idle();
  await h.settle();
  await sleep(2500);
  return panel().id;
}

async function slots(h: CasinoHarness, users: (n: string) => FakeUser): Promise<string> {
  const alex = users('Alex');
  const hub = h.seen(await h.click(alex, h.seen(await h.slash(alex, 'casino')), 'Games'))!;
  const machine = h.seen(await h.click(alex, hub, 'Play slots'))!;
  for (let i = 0; i < 3; i++) {
    await sleep(THINK);
    const spin = h.buttons(machine).find((b) => b.label?.startsWith('Spin'))!;
    await h.click(alex, machine, spin.label!);
  }
  await sleep(2000);
  return machine.id;
}

async function coinflip(h: CasinoHarness, users: (n: string) => FakeUser): Promise<string> {
  const [alex, hanna] = [users('Alex'), users('Hanna')];
  const hub = h.seen(await h.click(alex, h.seen(await h.slash(alex, 'casino')), 'Games'))!;
  await sleep(THINK);
  const pick = await h.select(alex, hub, 'cf:pick', [hanna.id]);
  const sent = await h.submit(alex, pick, { amount: '100', call: 'heads' });
  const card = h.seen(sent)!;
  await sleep(THINK);
  await h.click(hanna, card, /^Accept/);
  await sleep(2000);
  return card.id;
}

const SCENARIOS: Record<string, [string, (h: CasinoHarness, u: (n: string) => FakeUser) => Promise<string | null>]> = {
  blackjack: ['Blackjack — three players, split, double, dealer reveal', blackjack],
  roulette: ['Roulette — two bets and a spin', roulette],
  slots: ['Slots — three spins', slots],
  coinflip: ['Coinflip — challenge and accept', coinflip],
};

// ───────────────────────────── output ─────────────────────────────

function html(rec: Recording, frames: Array<{ entry: TimelineEntry; file: string | null }>): string {
  const data = frames.map(({ entry, file }) => ({
    t: entry.at - rec.start,
    id: entry.messageId,
    who: entry.forUser ? `only visible to ${rec.names.get(entry.forUser) ?? 'player'}` : 'public',
    accent: entry.accent,
    text: entry.text,
    buttons: entry.buttons,
    selects: entry.selects,
    // Embedded, so the replay is one self-contained file.
    image: entry.image ? `data:image/${entry.image.filename.endsWith('.gif') ? 'gif' : 'png'};base64,${Buffer.from(entry.image.data).toString('base64')}` : null,
    file,
    focus: entry.messageId === rec.focus,
  }));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${rec.title}</title>
<style>
body{background:#313338;color:#dbdee1;font:15px/1.4 "gg sans","Segoe UI",sans-serif;margin:0;padding:24px}
h1{font-size:18px;margin:0 0 4px} .sub{color:#949ba4;font-size:13px;margin-bottom:16px}
.wrap{display:flex;gap:28px;align-items:flex-start;flex-wrap:wrap}
.msg{width:520px;background:#2b2d31;border-radius:8px;border-left:4px solid #4e5058;padding:12px 14px;box-sizing:border-box}
.msg img{width:100%;border-radius:6px;margin:8px 0;display:block}
.t p{margin:2px 0} .t h2{font-size:20px;margin:4px 0} .t h3{font-size:16px;margin:6px 0 2px} .small{color:#949ba4;font-size:12.5px}
.btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px} .b{padding:6px 12px;border-radius:6px;font-size:14px;font-weight:600;color:#fff}
.s1{background:#5865f2}.s2{background:#4e5058}.s3{background:#248046}.s4{background:#da373c}.s5{background:#4e5058}.dis{opacity:.45}
.sel{background:#1e1f22;border-radius:6px;padding:8px 10px;color:#949ba4;margin-top:8px}
.meta{color:#949ba4;font-size:12px;margin-bottom:6px} .ctrl button{background:#5865f2;border:0;color:#fff;padding:6px 12px;border-radius:6px;margin-right:6px;cursor:pointer}
.list .msg{margin-bottom:14px;width:420px}
</style></head><body>
<h1>${rec.title}</h1><div class="sub">Rendered from the bot's real payloads (same image and text Discord receives), with the bot's production timings and ${LATENCY} ms simulated network latency. Not a screen capture of the Discord client.</div>
<div class="ctrl"><button onclick="play()">▶ Replay</button><button onclick="step(-1)">◀ Step</button><button onclick="step(1)">Step ▶</button> <span id="clock" class="small"></span></div>
<div class="wrap"><div><div class="meta" id="meta"></div><div class="msg" id="stage"></div></div><div class="list" id="others"></div></div>
<script>
const frames=${JSON.stringify(data)};
const focus=frames.filter(f=>f.focus);let idx=0,timer=null;
function md(s){return s.split('\\n').map(l=>{l=l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\\*\\*(.+?)\\*\\*/g,'<b>$1</b>').replace(/~~(.+?)~~/g,'<s>$1</s>').replace(/__(.+?)__/g,'<u>$1</u>').replace(/\\*(.+?)\\*/g,'<i>$1</i>');
if(l.startsWith('## '))return '<h2>'+l.slice(3)+'</h2>';if(l.startsWith('### '))return '<h3>'+l.slice(4)+'</h3>';if(l.startsWith('# '))return '<h2>'+l.slice(2)+'</h2>';if(l.startsWith('-# '))return '<p class="small">'+l.slice(3)+'</p>';return '<p>'+l+'</p>'}).join('')}
function render(f,el){el.style.borderLeftColor=f.accent!=null?'#'+f.accent.toString(16).padStart(6,'0'):'#4e5058';
const parts=f.text.split('\\n');el.innerHTML='<div class="t">'+md(f.text)+'</div>'+(f.image?'<img src="'+f.image+'">':'')+f.selects.map(s=>'<div class="sel">'+s+' ▾</div>').join('')+'<div class="btns">'+f.buttons.map(b=>'<span class="b s'+b.style+(b.disabled?' dis':'')+'">'+(b.emoji?b.emoji+' ':'')+b.label+'</span>').join('')+'</div>'}
function show(i){idx=Math.max(0,Math.min(focus.length-1,i));const f=focus[idx];render(f,document.getElementById('stage'));document.getElementById('meta').textContent='Panel · frame '+(idx+1)+'/'+focus.length+' · t = '+(f.t/1000).toFixed(2)+' s'+(idx?' (+'+((f.t-focus[idx-1].t)/1000).toFixed(2)+' s)':'');}
function step(d){clearTimeout(timer);show(idx+d)}
function play(){clearTimeout(timer);let i=0;const go=()=>{show(i);if(i<focus.length-1){const dt=focus[i+1].t-focus[i].t;i++;timer=setTimeout(go,dt)}};go()}
const others=document.getElementById('others');frames.filter(f=>!f.focus).forEach(f=>{const d=document.createElement('div');d.className='msg';const m=document.createElement('div');m.className='meta';m.textContent='t = '+(f.t/1000).toFixed(2)+' s · '+f.who;others.appendChild(m);render(f,d);others.appendChild(d)});
show(0);
</script></body></html>`;
}

async function main(): Promise<void> {
  const chosen = args.filter((a) => !a.startsWith('--') && SCENARIOS[a]);
  const names = chosen.length ? chosen : Object.keys(SCENARIOS);
  for (const name of names) {
    const [title, play] = SCENARIOS[name]!;
    const rec = await session(name, title, play);
    const dir = join('recordings', name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const frames = rec.entries.map((entry, i) => {
      if (!entry.image) return { entry, file: null };
      const file = `frame-${String(i + 1).padStart(3, '0')}.${entry.image.filename.endsWith('.gif') ? 'gif' : 'png'}`;
      writeFileSync(join(dir, file), entry.image.data);
      return { entry, file };
    });
    writeFileSync(join(dir, 'index.html'), html(rec, frames));
    const md = frames
      .map(({ entry, file }, i) => `## ${i + 1} · t=${((entry.at - rec.start) / 1000).toFixed(2)}s · ${entry.op} · ${entry.messageId === rec.focus ? 'PANEL' : entry.forUser ? `private (${rec.names.get(entry.forUser) ?? '?'})` : 'public'}${file ? ` · ${file}` : ''}\n${entry.text}\nbuttons: ${entry.buttons.map((b) => `${b.label}${b.disabled ? '(x)' : ''}`).join(' | ')}${entry.selects.length ? `\nselects: ${entry.selects.join(' | ')}` : ''}\n`)
      .join('\n');
    writeFileSync(join(dir, 'frames.md'), md);
    const panelFrames = rec.entries.filter((e) => e.messageId === rec.focus);
    console.log(`${name}: ${rec.entries.length} message changes (${panelFrames.length} on the main panel) over ${((rec.entries.at(-1)!.at - rec.start) / 1000).toFixed(1)} s → ${join(dir, 'index.html')}`);
  }
}

void main();
