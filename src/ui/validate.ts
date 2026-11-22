import { ComponentType } from 'discord.js';
import type { Screen } from './kit.js';

/**
 * Structural validation of a Components V2 payload against Discord's documented limits.
 * Used by tests for every screen, and in development before sending.
 */
export const LIMITS = {
  totalComponents: 40,
  totalText: 4000,
  containerChildren: 10,
  rowButtons: 5,
  customId: 100,
  buttonLabel: 80,
  selectOptions: 25,
  galleryItems: 10,
  sectionTexts: 3,
} as const;

interface AnyComponent {
  type: number;
  components?: AnyComponent[];
  accessory?: AnyComponent;
  custom_id?: string;
  label?: string;
  content?: string;
  items?: { media: { url: string } }[];
  options?: unknown[];
  url?: string;
  style?: number;
}

export interface ValidationReport {
  errors: string[];
  componentCount: number;
  textLength: number;
  customIds: string[];
}

export function validateScreen(screen: Screen): ValidationReport {
  const errors: string[] = [];
  const customIds: string[] = [];
  let count = 0;
  let textLength = 0;
  const attachmentNames = new Set((screen.files ?? []).map((f) => f.name));

  const visit = (c: AnyComponent, parent: string): void => {
    count++;
    if (c.custom_id !== undefined) {
      customIds.push(c.custom_id);
      if (c.custom_id.length === 0 || c.custom_id.length > LIMITS.customId) errors.push(`${parent}: custom_id length ${c.custom_id.length}`);
    }
    switch (c.type) {
      case ComponentType.Container: {
        const kids = c.components ?? [];
        if (kids.length === 0) errors.push('container is empty');
        if (kids.length > LIMITS.containerChildren) errors.push(`container has ${kids.length} children (max ${LIMITS.containerChildren})`);
        for (const k of kids) {
          if (k.type === ComponentType.Container) errors.push('containers cannot be nested');
          visit(k, 'container');
        }
        break;
      }
      case ComponentType.ActionRow: {
        const kids = c.components ?? [];
        if (kids.length === 0) errors.push(`${parent}: empty action row`);
        const selects = kids.filter((k) => k.type !== ComponentType.Button);
        if (selects.length > 0 && kids.length > 1) errors.push(`${parent}: a select must be alone in its row`);
        if (kids.length > LIMITS.rowButtons) errors.push(`${parent}: row has ${kids.length} buttons`);
        for (const k of kids) visit(k, 'row');
        break;
      }
      case ComponentType.Section: {
        const kids = c.components ?? [];
        if (kids.length < 1 || kids.length > LIMITS.sectionTexts) errors.push(`section has ${kids.length} texts`);
        for (const k of kids) visit(k, 'section');
        if (!c.accessory) errors.push('section without accessory');
        else visit(c.accessory, 'section accessory');
        break;
      }
      case ComponentType.TextDisplay:
        textLength += c.content?.length ?? 0;
        if (!c.content) errors.push(`${parent}: empty text display`);
        break;
      case ComponentType.MediaGallery: {
        const items = c.items ?? [];
        if (items.length < 1 || items.length > LIMITS.galleryItems) errors.push(`gallery has ${items.length} items`);
        for (const item of items) checkMedia(item.media.url);
        break;
      }
      case ComponentType.Button:
        if (c.label && c.label.length > LIMITS.buttonLabel) errors.push(`button label too long: ${c.label}`);
        if (c.style === 5 ? !c.url : !c.custom_id) errors.push(`button missing ${c.style === 5 ? 'url' : 'custom_id'}`);
        break;
      case ComponentType.StringSelect:
        if ((c.options?.length ?? 0) < 1 || (c.options?.length ?? 0) > LIMITS.selectOptions) errors.push(`select has ${c.options?.length} options`);
        break;
      default:
        break;
    }
  };

  const checkMedia = (url: string): void => {
    if (url.startsWith('attachment://')) {
      const name = url.slice('attachment://'.length);
      if (!attachmentNames.has(name)) errors.push(`media references missing attachment ${name}`);
    } else if (!/^https:\/\//.test(url)) {
      errors.push(`media url must be https or attachment://: ${url}`);
    }
  };

  for (const top of screen.components as AnyComponent[]) {
    if (top.type === ComponentType.Button) errors.push('buttons must be inside an action row');
    visit(top, 'top');
    if (top.type === ComponentType.Section && top.accessory?.type === ComponentType.Thumbnail) {
      const media = (top.accessory as unknown as { media: { url: string } }).media;
      checkMedia(media.url);
    }
  }
  // Thumbnails nested in containers.
  const walkThumbs = (c: AnyComponent): void => {
    if (c.type === ComponentType.Section && c.accessory?.type === ComponentType.Thumbnail) {
      checkMedia((c.accessory as unknown as { media: { url: string } }).media.url);
    }
    for (const k of c.components ?? []) walkThumbs(k);
  };
  for (const top of screen.components as AnyComponent[]) if (top.type === ComponentType.Container) walkThumbs(top);

  if (count > LIMITS.totalComponents) errors.push(`message has ${count} components (max ${LIMITS.totalComponents})`);
  if (textLength > LIMITS.totalText) errors.push(`message has ${textLength} characters of text (max ${LIMITS.totalText})`);
  const dupes = customIds.filter((id, i) => customIds.indexOf(id) !== i);
  if (dupes.length) errors.push(`duplicate custom_ids: ${[...new Set(dupes)].join(', ')}`);
  return { errors, componentCount: count, textLength, customIds };
}

export function assertValidScreen(screen: Screen): void {
  const report = validateScreen(screen);
  if (report.errors.length) throw new Error(`Invalid Discord payload:\n  ${report.errors.join('\n  ')}`);
}
