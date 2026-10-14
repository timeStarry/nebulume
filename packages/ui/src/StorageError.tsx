import { Show, createMemo } from 'solid-js';
import { storageErrorPresentation } from './storage-error';

export default function StorageError(props: {
  error: unknown;
  onSettings?: () => void;
  disabled?: boolean;
}) {
  const presentation = createMemo(() => storageErrorPresentation(props.error));
  return (
    <div class="storage-error-content">
      <p>{presentation().summary}</p>
      <Show when={props.onSettings}>
        <button
          class="button small"
          type="button"
          onClick={props.onSettings}
          disabled={props.disabled}
        >
          打开连接设置
        </button>
      </Show>
      <Show when={presentation().details}>
        <details>
          <summary>查看错误详情</summary>
          <pre>{presentation().details}</pre>
        </details>
      </Show>
    </div>
  );
}
