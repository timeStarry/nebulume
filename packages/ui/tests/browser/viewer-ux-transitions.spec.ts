import { expect, test } from '@playwright/test';
import { fixture } from './viewer-fixture';

test('slim 40px top bar never occludes the photo stage and aligns pixel-for-pixel with the [›] filename inspector header', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/?viewer=1');
  await expect(page.locator('.main-photo')).toBeVisible();

  const bar = page.locator('.nl-viewer-bar');
  const stage = page.locator('.photo-stage');
  const wrap = page.locator('.photo-wrap');

  const barBox = (await bar.boundingBox())!;
  const stageBox = (await stage.boundingBox())!;
  const wrapBox = (await wrap.boundingBox())!;

  expect(barBox.height).toBe(40);
  // Dedicated non-overlapping bar: stage starts at or below the bottom of the 40px bar.
  expect(stageBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 0.5);
  expect(wrapBox.y).toBeGreaterThan(barBox.y + barBox.height);

  // Open info sidebar and verify [›] FileName.PNG header, zero redundant "影像信息" filler,
  // zero top-right window-close `×`, and exact 40px bottom-border alignment.
  await page.keyboard.press('i');
  const inspector = page.getByRole('complementary', { name: '影像详情' });
  await expect(inspector).toBeVisible();

  const heading = inspector.locator('.inspector-heading');
  await expect(heading.locator('h2')).toHaveText('Frame-1.png');
  await expect(heading).not.toContainText('影像信息');
  await expect(inspector.getByRole('button', { name: '关闭影像详情' })).toHaveCount(0);

  const headingBox = (await heading.boundingBox())!;
  expect(headingBox.height).toBe(40);
  expect(Math.abs(headingBox.y + headingBox.height - (barBox.y + barBox.height))).toBeLessThan(1);

  // Collapsing via the left-aligned [›] button closes only the drawer, keeping the viewer open.
  await inspector.getByRole('button', { name: '收起影像详情' }).click();
  await expect(inspector).toHaveCount(0);
  await expect(page.locator('.main-photo')).toBeVisible();
});

test('optional toolbar auto-hide setting floats the slim bar, hides when pointer rests away, and wakes near top edge', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('nebulume.viewer.toolbar-autohide', 'true');
  });
  await fixture(page);
  await page.goto('/?viewer=1');
  await expect(page.locator('.main-photo')).toBeVisible();

  const bar = page.locator('.nl-viewer-bar');
  const stage = page.locator('.photo-stage');
  const stageBox = (await stage.boundingBox())!;
  // In auto-hide mode, stage extends edge-to-edge starting at y = 0.
  expect(stageBox.y).toBeLessThanOrEqual(1);

  // Move pointer into the middle of the stage and wait for toolbar sleep.
  await page.mouse.move(400, 360);
  await expect(bar).toHaveCSS('opacity', '0', { timeout: 3500 });

  // Moving pointer near the top zone (< 64px) wakes the bar immediately.
  await page.mouse.move(400, 18);
  await expect(bar).toHaveCSS('opacity', '1');
});

test('switching prev/next photos never unmounts the inspector or photo-wrap and swaps cached frames with zero jump', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/?viewer=1');
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'Frame-1.png');

  await page.keyboard.press('i');
  const inspector = page.getByRole('complementary', { name: '影像详情' });
  await expect(inspector.locator('.inspector-heading h2')).toHaveText('Frame-1.png');

  // Record exact live DOM node identities and stage dimensions before switching.
  const initialBox = (await page.locator('.photo-wrap').boundingBox())!;
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__inspectorNode = document.querySelector('.asset-inspector');
    w.__wrapNode = document.querySelector('.photo-wrap');
    let inspectorUnmounted = false;
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.asset-inspector')) inspectorUnmounted = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    w.__wasInspectorUnmounted = () => inspectorUnmounted;
  });

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'Frame-2.png');
  await expect(inspector.locator('.inspector-heading h2')).toHaveText('Frame-2.png');

  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.main-photo')).toHaveAttribute('alt', 'Frame-1.png');
  await expect(inspector.locator('.inspector-heading h2')).toHaveText('Frame-1.png');

  const continuity = await page.evaluate(() => {
    const w = window as unknown as {
      __inspectorNode: Element | null;
      __wrapNode: Element | null;
      __wasInspectorUnmounted: () => boolean;
    };
    return {
      sameInspector: document.querySelector('.asset-inspector') === w.__inspectorNode,
      sameWrap: document.querySelector('.photo-wrap') === w.__wrapNode,
      inspectorUnmounted: w.__wasInspectorUnmounted(),
    };
  });
  expect(continuity).toEqual({
    sameInspector: true,
    sameWrap: true,
    inspectorUnmounted: false,
  });

  const afterBox = (await page.locator('.photo-wrap').boundingBox())!;
  expect(Math.abs(afterBox.width - initialBox.width)).toBeLessThan(0.5);
  expect(Math.abs(afterBox.height - initialBox.height)).toBeLessThan(0.5);
});
