import { createMemo, createSignal } from 'solid-js';
import {
  targetsForOriginalChoice,
  type OriginalExportPlan,
  type OriginalFormatChoice,
} from './photo-actions';
import { Button, Dialog, Field, Segmented } from './ui';
import './OriginalExportDialog.css';

const CHOICE_KEY = 'nebulume.original-export-choice';

function readInitialChoice(): OriginalFormatChoice {
  try {
    const saved = localStorage.getItem(CHOICE_KEY);
    if (saved === 'raw' || saved === 'jpeg' || saved === 'both') return saved;
  } catch {
    /* Session fallback. */
  }
  return 'raw';
}

function writeInitialChoice(choice: OriginalFormatChoice) {
  try {
    localStorage.setItem(CHOICE_KEY, choice);
  } catch {
    /* Session fallback. */
  }
}

export default function OriginalExportDialog(props: {
  plan: OriginalExportPlan;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (choice: OriginalFormatChoice) => void;
}) {
  const [choice, setChoice] = createSignal<OriginalFormatChoice>(readInitialChoice());

  const chosenTargets = createMemo(() => targetsForOriginalChoice(props.plan, choice()));
  const samplePreview = createMemo(() => {
    const list = chosenTargets();
    if (!list.length) return '';
    const names = list.slice(0, 2).map((item) => item.filename);
    return list.length > 2 ? `${names.join('、')} 等共 ${list.length} 个文件` : names.join('、');
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (props.busy || !chosenTargets().length) return;
    writeInitialChoice(choice());
    props.onConfirm(choice());
  }

  return (
    <Dialog
      title="导出原片"
      subtitle={
        props.plan.photoCount === 1
          ? '此照片包含配对的 RAW 与 JPEG 原片，请选择要导出的格式（原样复制，绝不重编码）。'
          : '所选照片同时包含 RAW 与 JPEG 原片，请选择要导出的格式（原样复制，绝不重编码）。'
      }
      width={460}
      busy={props.busy}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={props.busy}>
            取消
          </Button>
          <Button
            type="submit"
            form="original-export-form"
            variant="primary"
            icon="download"
            disabled={props.busy || !chosenTargets().length}
            busy={props.busy}
          >
            {`导出 ${chosenTargets().length} 个原片…`}
          </Button>
        </>
      }
    >
      <form id="original-export-form" class="original-export-grid" onSubmit={submit}>
        <Field label="原片格式" help={samplePreview() ? `示例：${samplePreview()}` : undefined}>
          {() => (
            <Segmented
              label="原片格式"
              value={choice()}
              onChange={setChoice}
              options={[
                { value: 'raw', label: `仅 RAW（${props.plan.rawTargets.length}）` },
                { value: 'jpeg', label: `仅 JPEG（${props.plan.rasterTargets.length}）` },
                { value: 'both', label: `RAW + JPEG（${props.plan.allTargets.length}）` },
              ]}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
