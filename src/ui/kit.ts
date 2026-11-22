import {
  ButtonStyle,
  ComponentType,
  SeparatorSpacingSize,
  TextInputStyle,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInContainer,
  type APIComponentInMessageActionRow,
  type APIContainerComponent,
  type APILabelComponent,
  type APIMediaGalleryComponent,
  type APIMessageTopLevelComponent,
  type APISectionComponent,
  type APISelectMenuOption,
  type APISeparatorComponent,
  type APIStringSelectComponent,
  type APITextDisplayComponent,
  type APITextInputComponent,
  type APIThumbnailComponent,
  type APIUserSelectComponent,
} from 'discord.js';

/**
 * Building blocks for Components V2 messages, producing plain API JSON. Screens compose these;
 * the Discord layer sends them with the IS_COMPONENTS_V2 flag. Plain data keeps every screen
 * testable without a Discord connection.
 */

export interface FileAttachment {
  name: string;
  data: Buffer;
  description?: string;
}

export interface Screen {
  components: APIMessageTopLevelComponent[];
  files?: FileAttachment[];
}

export type ButtonTone = 'primary' | 'secondary' | 'success' | 'danger';

const STYLE: Record<ButtonTone, ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

export function text(content: string): APITextDisplayComponent {
  return { type: ComponentType.TextDisplay, content };
}

export function separator(options: { divider?: boolean; large?: boolean } = {}): APISeparatorComponent {
  return {
    type: ComponentType.Separator,
    divider: options.divider ?? true,
    spacing: options.large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small,
  };
}

export function container(accent: number, components: (APIComponentInContainer | null | undefined | false)[]): APIContainerComponent {
  return { type: ComponentType.Container, accent_color: accent, components: components.filter(isPresent) };
}

export function thumbnail(url: string, description?: string): APIThumbnailComponent {
  return { type: ComponentType.Thumbnail, media: { url }, ...(description ? { description: description.slice(0, 1024) } : {}) };
}

export function section(texts: string[], accessory: APIThumbnailComponent | APIButtonComponent): APISectionComponent {
  return { type: ComponentType.Section, components: texts.slice(0, 3).map(text), accessory };
}

export function gallery(items: { url: string; description?: string }[]): APIMediaGalleryComponent {
  return {
    type: ComponentType.MediaGallery,
    items: items.map((item) => ({ media: { url: item.url }, ...(item.description ? { description: item.description.slice(0, 1024) } : {}) })),
  };
}

export interface ButtonSpec {
  id: string;
  label?: string;
  tone?: ButtonTone;
  emoji?: string;
  disabled?: boolean;
}

export function button(spec: ButtonSpec): APIButtonComponent {
  return {
    type: ComponentType.Button,
    custom_id: spec.id,
    style: STYLE[spec.tone ?? 'secondary'],
    ...(spec.label ? { label: spec.label.slice(0, 80) } : {}),
    ...(spec.emoji ? { emoji: { name: spec.emoji } } : {}),
    ...(spec.disabled ? { disabled: true } : {}),
  } as APIButtonComponent;
}

export function linkButton(label: string, url: string, emoji?: string): APIButtonComponent {
  return {
    type: ComponentType.Button,
    style: ButtonStyle.Link,
    label,
    url,
    ...(emoji ? { emoji: { name: emoji } } : {}),
  };
}

export function row(...components: (APIComponentInMessageActionRow | null | undefined | false)[]): APIActionRowComponent<APIComponentInMessageActionRow> {
  return { type: ComponentType.ActionRow, components: components.filter(isPresent) };
}

export function select(spec: {
  id: string;
  placeholder: string;
  options: APISelectMenuOption[];
  disabled?: boolean;
}): APIActionRowComponent<APIStringSelectComponent> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        custom_id: spec.id,
        placeholder: spec.placeholder.slice(0, 150),
        options: spec.options.slice(0, 25),
        ...(spec.disabled ? { disabled: true } : {}),
      },
    ],
  };
}

export function userSelect(id: string, placeholder: string): APIActionRowComponent<APIUserSelectComponent> {
  return {
    type: ComponentType.ActionRow,
    components: [{ type: ComponentType.UserSelect, custom_id: id, placeholder, min_values: 1, max_values: 1 }],
  };
}

export function option(label: string, value: string, description?: string, emoji?: string, isDefault?: boolean): APISelectMenuOption {
  return {
    label: label.slice(0, 100),
    value: value.slice(0, 100),
    ...(description ? { description: description.slice(0, 100) } : {}),
    ...(emoji ? { emoji: { name: emoji } } : {}),
    ...(isDefault ? { default: true } : {}),
  };
}

// ── Modals ──

export interface ModalSpec {
  custom_id: string;
  title: string;
  components: (APILabelComponent | APITextDisplayComponent)[];
}

export function modal(id: string, title: string, components: (APILabelComponent | APITextDisplayComponent)[]): ModalSpec {
  return { custom_id: id, title: title.slice(0, 45), components };
}

export function textInputLabel(spec: {
  id: string;
  label: string;
  description?: string;
  placeholder?: string;
  value?: string;
  required?: boolean;
  min?: number;
  max?: number;
  paragraph?: boolean;
}): APILabelComponent {
  const input: APITextInputComponent = {
    type: ComponentType.TextInput,
    custom_id: spec.id,
    style: spec.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short,
    required: spec.required ?? true,
    ...(spec.placeholder ? { placeholder: spec.placeholder.slice(0, 100) } : {}),
    ...(spec.value !== undefined ? { value: spec.value.slice(0, 4000) } : {}),
    ...(spec.min !== undefined ? { min_length: spec.min } : {}),
    ...(spec.max !== undefined ? { max_length: spec.max } : {}),
  };
  return {
    type: ComponentType.Label,
    label: spec.label.slice(0, 45),
    ...(spec.description ? { description: spec.description.slice(0, 100) } : {}),
    component: input,
  };
}

export function selectLabel(spec: {
  id: string;
  label: string;
  description?: string;
  options: APISelectMenuOption[];
  placeholder?: string;
}): APILabelComponent {
  return {
    type: ComponentType.Label,
    label: spec.label.slice(0, 45),
    ...(spec.description ? { description: spec.description.slice(0, 100) } : {}),
    component: {
      type: ComponentType.StringSelect,
      custom_id: spec.id,
      options: spec.options.slice(0, 25),
      ...(spec.placeholder ? { placeholder: spec.placeholder } : {}),
    },
  };
}

function isPresent<T>(value: T | null | undefined | false): value is T {
  return value !== null && value !== undefined && value !== false;
}

/** Text progress bar, e.g. ▰▰▰▱▱ */
export function progressBar(fraction: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}
