import { Show, createMemo } from 'solid-js';
import Icon from './Icon';
import { storageErrorPresentation } from './storage-error';
import { Button } from './ui';

export default function StorageError(props: {
  error: unknown;
  onSettings?: () => void;
  disabled?: boolean;
}) {
  const presentation = createMemo(() => storageErrorPresentation(props.error));
  return (
    <div class="nl-banner nl-banner--error storage-error-banner" role="alert">
      <Icon name="alert-circle" size={18} />
      <div class="storage-error-content">
        <div class="storage-error-row">
          <p>{presentation().summary}</p>
          <Show when={props.onSettings}>
            <Button size="sm" onClick={props.onSettings} disabled={props.disabled}>
              打开连接设置
            </Button>
          </Show>
        </div>
        <Show when={presentation().details}>
          <details>
            <summary>查看错误详情</summary>
            <pre>{presentation().details}</pre>
          </details>
        </Show>
      </div>
    </div>
  );
}
