import { For, Show, createSignal } from 'solid-js';
import { execute } from '../api';
import { errorMessage, type Collection } from '../model';
import { Button, Dialog, TextInput } from '../ui';
import './CollectionDialogs.css';

export function CollectionPickerDialog(props: {
  libraryId: string;
  assetIds: string[];
  collections: Collection[];
  onClose: () => void;
  onPicked: (collection: Collection, added: number) => void;
}) {
  const [newName, setNewName] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const manualCollections = () => props.collections.filter((item) => item.kind === 'manual');

  async function pickExisting(target: Collection) {
    setBusy(true);
    setError('');
    try {
      const res = await execute<{ added: number; collection: Collection }>('collection.add_assets', {
        id: target.id,
        asset_ids: props.assetIds,
      });
      props.onPicked(res.collection, res.added);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createAndAdd(event?: Event) {
    event?.preventDefault();
    const clean = newName().trim();
    if (!clean) return;
    setBusy(true);
    setError('');
    try {
      const created = await execute<Collection>('collection.create', {
        library_id: props.libraryId,
        name: clean,
        kind: 'manual',
        asset_ids: props.assetIds,
      });
      props.onPicked(created, props.assetIds.length);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`将 ${props.assetIds.length} 张照片加入精选集`}
      subtitle="精选集只建立虚拟引用，不复制或移动原始照片。"
      width={440}
      busy={busy()}
      onClose={props.onClose}
    >
      <div class="collection-dialog-form">
        <Show
          when={manualCollections().length}
          fallback={<p class="muted">当前图片库还没有手动精选集，可在下方直接新建并加入。</p>}
        >
          <ul class="collection-picker-list" aria-label="可用精选集">
            <For each={manualCollections()}>
              {(item) => (
                <li>
                  <button
                    type="button"
                    class="collection-picker-row"
                    disabled={busy()}
                    onClick={() => void pickExisting(item)}
                  >
                    <span>{item.name}</span>
                    <small>{item.item_count} 张</small>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <form class="collection-picker-create" onSubmit={(e) => void createAndAdd(e)}>
          <TextInput
            size="sm"
            value={newName()}
            onInput={(e) => setNewName(e.currentTarget.value)}
            placeholder="新建精选集名称并加入…"
            aria-label="新建精选集名称"
            maxLength={80}
          />
          <Button
            size="sm"
            variant="primary"
            type="submit"
            disabled={busy() || !newName().trim()}
          >
            新建并加入
          </Button>
        </form>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
      </div>
    </Dialog>
  );
}
