export type InlineRun = { kind: 'text' | 'code' | 'strong'; text: string };
export type ReleaseNoteBlock =
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: InlineRun[][] };

export function parseInlineRuns(line: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const token = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let cursor = 0;
  for (const match of line.matchAll(token)) {
    const at = match.index ?? 0;
    if (at > cursor) runs.push({ kind: 'text', text: line.slice(cursor, at) });
    if (match[1] !== undefined) runs.push({ kind: 'code', text: match[1] });
    else if (match[2] !== undefined) runs.push({ kind: 'strong', text: match[2] });
    cursor = at + match[0].length;
  }
  if (cursor < line.length) runs.push({ kind: 'text', text: line.slice(cursor) });
  return runs.length ? runs : [{ kind: 'text', text: line }];
}

function stripInlineMarkup(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*•]\s+/, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .trim();
}

export function parseReleaseNotes(raw: string): { headline: string; blocks: ReleaseNoteBlock[] } {
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  if (!normalized) return { headline: '', blocks: [] };

  const lines = normalized.split('\n');
  const blocks: ReleaseNoteBlock[] = [];
  let currentList: InlineRun[][] | null = null;
  const flushList = () => {
    if (currentList && currentList.length) {
      blocks.push({ kind: 'list', items: currentList });
      currentList = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed || /^-{3,}$/.test(trimmed)) {
      flushList();
      continue;
    }
    const mdHeading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (mdHeading) {
      flushList();
      blocks.push({ kind: 'heading', text: stripInlineMarkup(mdHeading[1]!) });
      continue;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      if (!currentList) currentList = [];
      currentList.push(parseInlineRuns(bullet[1]!.trim()));
      continue;
    }
    // Standalone section labels (e.g. "远端预览与缓存架构") immediately preceding bullets.
    const nextNonEmpty = lines.slice(i + 1).find((candidate) => candidate.trim().length > 0)?.trim();
    if (
      nextNonEmpty &&
      /^[-*•]\s+/.test(nextNonEmpty) &&
      trimmed.length <= 28 &&
      !/[。！？.!?；;]$/.test(trimmed)
    ) {
      flushList();
      blocks.push({ kind: 'heading', text: stripInlineMarkup(trimmed) });
      continue;
    }
    flushList();
    blocks.push({ kind: 'paragraph', runs: parseInlineRuns(trimmed) });
  }
  flushList();

  let headline = '';
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      headline = block.runs.map((r) => r.text).join('').trim();
      break;
    }
    if (block.kind === 'list' && block.items[0]) {
      headline = block.items[0].map((r) => r.text).join('').trim();
      break;
    }
  }
  return { headline, blocks };
}
