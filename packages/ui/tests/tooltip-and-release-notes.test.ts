import { describe, expect, it } from 'vitest';
import { parseInlineRuns, parseReleaseNotes } from '../src/release-notes';
import { computeTooltipPosition } from '../src/ui/tooltip-layout';

describe('computeTooltipPosition', () => {
  it('centers below the anchor when unobstructed and escapes narrow sidebar containers', () => {
    // Sidebar is 280px wide, '...' button sits at x=[246..272], viewport is 1280x800.
    // Because tooltips render on document.body, x is computed in viewport space rather than clipped at 280px.
    const pos = computeTooltipPosition(
      { left: 246, right: 272, top: 88, bottom: 114, width: 26, height: 26 },
      { width: 140, height: 28 },
      { width: 1280, height: 800 },
      'bottom',
      'center',
    );
    expect(pos).toEqual({ x: 189, y: 120 });
  });

  it('clamps tooltips inside the right and left viewport margins', () => {
    const nearRight = computeTooltipPosition(
      { left: 1244, right: 1272, top: 40, bottom: 68, width: 28, height: 28 },
      { width: 160, height: 28 },
      { width: 1280, height: 800 },
      'bottom',
    );
    expect(nearRight.x).toBe(1280 - 160 - 8);

    const nearLeft = computeTooltipPosition(
      { left: 4, right: 32, top: 40, bottom: 68, width: 28, height: 28 },
      { width: 160, height: 28 },
      { width: 1280, height: 800 },
      'bottom',
    );
    expect(nearLeft.x).toBe(8);
  });

  it('flips from bottom to top near the bottom viewport edge', () => {
    const flipped = computeTooltipPosition(
      { left: 400, right: 432, top: 760, bottom: 788, width: 32, height: 28 },
      { width: 120, height: 28 },
      { width: 1280, height: 800 },
      'bottom',
    );
    expect(flipped.y).toBe(760 - 6 - 28);
  });

  it('places rail tooltips to the right of the anchor centered vertically', () => {
    const railPos = computeTooltipPosition(
      { left: 8, right: 48, top: 720, bottom: 760, width: 40, height: 40 },
      { width: 148, height: 28 },
      { width: 1280, height: 800 },
      'right',
    );
    expect(railPos).toEqual({ x: 54, y: 726 });
  });
});

describe('parseReleaseNotes', () => {
  it('parses CHANGELOG-style sections, bullet lists, bold runs and inline code without raw backticks', () => {
    const raw = [
      '聚焦远端流式与内存缓存架构、跨平台统一交互语言及高频细节打磨。',
      '',
      '远端预览与缓存架构',
      '- 新增三档可选远端预览缓存模式：**自动缓存**与 `纯内存模式`。',
      '',
      '### 界面与交互细节',
      '- 自研跨平台统一 `<Select>` 下拉菜单组件；本地 `.xmp` 伴随文件同步默认开启。',
    ].join('\n');

    const parsed = parseReleaseNotes(raw);
    expect(parsed.headline).toBe('聚焦远端流式与内存缓存架构、跨平台统一交互语言及高频细节打磨。');
    expect(parsed.blocks).toHaveLength(5);
    expect(parsed.blocks[0]).toEqual({
      kind: 'paragraph',
      runs: [{ kind: 'text', text: '聚焦远端流式与内存缓存架构、跨平台统一交互语言及高频细节打磨。' }],
    });
    expect(parsed.blocks[1]).toEqual({ kind: 'heading', text: '远端预览与缓存架构' });
    expect(parsed.blocks[2]).toEqual({
      kind: 'list',
      items: [
        [
          { kind: 'text', text: '新增三档可选远端预览缓存模式：' },
          { kind: 'strong', text: '自动缓存' },
          { kind: 'text', text: '与 ' },
          { kind: 'code', text: '纯内存模式' },
          { kind: 'text', text: '。' },
        ],
      ],
    });
    expect(parsed.blocks[3]).toEqual({ kind: 'heading', text: '界面与交互细节' });
    expect(parsed.blocks[4]).toEqual({
      kind: 'list',
      items: [
        [
          { kind: 'text', text: '自研跨平台统一 ' },
          { kind: 'code', text: '<Select>' },
          { kind: 'text', text: ' 下拉菜单组件；本地 ' },
          { kind: 'code', text: '.xmp' },
          { kind: 'text', text: ' 伴随文件同步默认开启。' },
        ],
      ],
    });
  });

  it('derives headline from the first bullet when no intro paragraph exists', () => {
    const parsed = parseReleaseNotes('- 修复 `<Tooltip>` 溢出裁剪问题\n- 优化更新通知栏');
    expect(parsed.headline).toBe('修复 <Tooltip> 溢出裁剪问题');
    expect(parseInlineRuns('普通文本')).toEqual([{ kind: 'text', text: '普通文本' }]);
  });
});
