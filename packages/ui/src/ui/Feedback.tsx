import { Show, type JSX } from 'solid-js';
import Icon, { type IconName } from '../Icon';
import IconButton from './IconButton';
import './Feedback.css';

export type BannerTone = 'neutral' | 'info' | 'warn' | 'error';
const BANNER_ICON: Record<BannerTone, IconName> = {
  neutral: 'info-circle',
  info: 'info-circle',
  warn: 'alert-triangle',
  error: 'alert-circle',
};

/** Lightweight single-line hint directly beneath a form field (no box, no border). */
export function FieldHint(props: {
  tone?: BannerTone;
  children: JSX.Element;
  class?: string;
}) {
  const tone = () => props.tone ?? 'neutral';
  return (
    <p
      class={`nl-field-hint nl-field-hint--${tone()}${props.class ? ` ${props.class}` : ''}`}
      role={tone() === 'error' ? 'alert' : 'note'}
    >
      <Icon name={BANNER_ICON[tone()]} size={14} />
      <span>{props.children}</span>
    </p>
  );
}

/** Above the content, until the user acts on it or closes it. */
export function Banner(props: {
  tone?: BannerTone;
  message: JSX.Element;
  detail?: JSX.Element;
  action?: JSX.Element;
  onClose?: () => void;
  closeLabel?: string;
  role?: 'status' | 'alert' | 'note';
  class?: string;
}) {
  const tone = () => props.tone ?? 'neutral';
  return (
    <div
      class={`nl-banner nl-banner--${tone()}${props.class ? ` ${props.class}` : ''}`}
      role={props.role ?? (tone() === 'error' ? 'alert' : 'status')}
    >
      <Icon name={BANNER_ICON[tone()]} size={18} />
      <p>
        {props.message}
        <Show when={props.detail}>
          {' '}
          <span>{props.detail}</span>
        </Show>
      </p>
      {props.action}
      <Show when={props.onClose}>
        <IconButton
          icon="x"
          size="xs"
          label={props.closeLabel ?? '关闭提示'}
          onClick={() => props.onClose?.()}
        />
      </Show>
    </div>
  );
}

/** A bottom-centre notice; the owner decides when it goes away. */
export function Toast(props: {
  tone?: 'neutral' | 'error' | 'busy';
  message: JSX.Element;
  action?: { label: string; run: () => void };
  /** Key that triggers `action`, shown next to it. */
  shortcut?: string;
  onClose?: () => void;
  closeLabel?: string;
}) {
  const tone = () => props.tone ?? 'neutral';
  return (
    <div class={`nl-toast nl-toast--${tone()}`} role={tone() === 'error' ? 'alert' : 'status'}>
      <Show
        when={tone() === 'busy'}
        fallback={<Icon name={tone() === 'error' ? 'alert-circle' : 'check'} size={16} />}
      >
        <span class="nl-spinner nl-spinner--sm" aria-hidden="true" />
      </Show>
      <span class="nl-toast-message">{props.message}</span>
      <Show when={props.action}>
        {(action) => (
          <button
            type="button"
            class="nl-toast-action"
            aria-keyshortcuts={props.shortcut}
            onClick={() => action().run()}
          >
            {action().label}
            <Show when={props.shortcut}>
              <kbd class="nl-kbd nl-toast-kbd">{props.shortcut}</kbd>
            </Show>
          </button>
        )}
      </Show>
      <Show when={props.onClose}>
        <button
          type="button"
          class="nl-toast-close"
          aria-label={props.closeLabel ?? '关闭提示'}
          onClick={() => props.onClose?.()}
        >
          <Icon name="x" size={14} />
        </button>
      </Show>
    </div>
  );
}

export function Progress(props: { value?: number; label: string; class?: string }) {
  const indeterminate = () => props.value === undefined;
  return (
    <div
      class={`nl-progress${indeterminate() ? ' nl-progress--indeterminate' : ''}${props.class ? ` ${props.class}` : ''}`}
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={indeterminate() ? undefined : 0}
      aria-valuemax={indeterminate() ? undefined : 100}
      aria-valuenow={indeterminate() ? undefined : Math.round(props.value! * 100)}
    >
      <span
        style={{
          width: indeterminate() ? undefined : `${Math.max(0, Math.min(1, props.value!)) * 100}%`,
        }}
      />
    </div>
  );
}

export function EmptyState(props: {
  icon: IconName;
  title: string;
  description?: JSX.Element;
  actions?: JSX.Element;
  role?: 'status' | 'alert' | 'region';
  class?: string;
}) {
  return (
    <div class={`nl-empty${props.class ? ` ${props.class}` : ''}`} role={props.role}>
      <span class="nl-empty-icon">
        <Icon name={props.icon} size={24} />
      </span>
      <h3>{props.title}</h3>
      <Show when={props.description}>
        <p>{props.description}</p>
      </Show>
      <Show when={props.actions}>
        <div class="nl-empty-actions">{props.actions}</div>
      </Show>
    </div>
  );
}
