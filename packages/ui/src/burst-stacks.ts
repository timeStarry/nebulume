import type { Asset } from './model';

export const DEFAULT_BURST_DELTA_MS = 2000;

export interface BurstDisplayItem {
  asset: Asset;
  stackId: string | null;
  stackCount: number;
  stackMemberIds: string[];
  isRepresentative: boolean;
  isStackExpanded: boolean;
  memberIndex: number;
}

export function parseCaptureTimestampMs(asset: Asset): number | null {
  const raw = asset.captured_at?.trim();
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = Date.parse(withZone);
  if (!Number.isFinite(parsed)) return null;
  const subsecRaw =
    asset.metadata?.['Capture Subsecond'] ?? asset.metadata?.['EXIF SubSecTimeOriginal'];
  if (subsecRaw && !/\.\d+/.test(normalized)) {
    const digits = subsecRaw.trim().replace(/\D+/g, '');
    if (digits.length > 0) {
      const fracMs = Math.round(Number(`0.${digits}`) * 1000);
      if (Number.isFinite(fracMs)) return parsed + fracMs;
    }
  }
  return parsed;
}

function cameraKey(asset: Asset): string {
  const cam = (asset.metadata?.Camera ?? asset.metadata?.Model ?? '').trim();
  if (cam) return `cam:${cam.toLowerCase()}`;
  const slash = asset.path.lastIndexOf('/');
  const folder = slash >= 0 ? asset.path.slice(0, slash) : '';
  return `dir:${asset.library_id}:${folder}`;
}

function representativeScore(asset: Asset): number {
  let score = 0;
  if (asset.flag === 'pick') score += 1000;
  else if (asset.flag === 'reject') score -= 1000;
  score += (asset.rating ?? 0) * 100;
  if (asset.color_label && asset.color_label !== 'none') score += 25;
  if (asset.crop) score += 10;
  return score;
}

export function pickBurstRepresentative(members: readonly Asset[]): Asset {
  let best = members[0];
  let bestScore = representativeScore(best);
  for (let i = 1; i < members.length; i += 1) {
    const candidate = members[i];
    const score = representativeScore(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function buildBurstStacks(
  items: readonly Asset[],
  expandedStackIds: ReadonlySet<string>,
  enabled: boolean,
  maxDeltaMs = DEFAULT_BURST_DELTA_MS,
): BurstDisplayItem[] {
  if (!enabled || items.length <= 1) {
    return items.map((asset) => ({
      asset,
      stackId: null,
      stackCount: 1,
      stackMemberIds: [asset.id],
      isRepresentative: true,
      isStackExpanded: false,
      memberIndex: 0,
    }));
  }

  const groups: Asset[][] = [];
  let currentGroup: Asset[] = [];
  let prevTime: number | null = null;
  let prevCam = '';

  const flushGroup = () => {
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
  };

  for (const asset of items) {
    const ts = parseCaptureTimestampMs(asset);
    const cam = cameraKey(asset);
    if (
      ts !== null &&
      prevTime !== null &&
      cam === prevCam &&
      Math.abs(ts - prevTime) <= maxDeltaMs &&
      currentGroup.length > 0 &&
      currentGroup[currentGroup.length - 1].library_id === asset.library_id
    ) {
      currentGroup.push(asset);
      prevTime = ts;
    } else {
      flushGroup();
      currentGroup = [asset];
      prevTime = ts;
      prevCam = cam;
    }
  }
  flushGroup();

  const result: BurstDisplayItem[] = [];
  for (const members of groups) {
    if (members.length === 1) {
      result.push({
        asset: members[0],
        stackId: null,
        stackCount: 1,
        stackMemberIds: [members[0].id],
        isRepresentative: true,
        isStackExpanded: false,
        memberIndex: 0,
      });
      continue;
    }
    // Anchor stackId on lexicographically smallest ID in the burst so sort direction
    // or rating changes never shift the stack's expand/collapse identity.
    const memberIds = members.map((m) => m.id);
    const stackId = [...memberIds].sort()[0];
    const rep = pickBurstRepresentative(members);
    const isExpanded = expandedStackIds.has(stackId);
    if (!isExpanded) {
      result.push({
        asset: rep,
        stackId,
        stackCount: members.length,
        stackMemberIds: memberIds,
        isRepresentative: true,
        isStackExpanded: false,
        memberIndex: members.indexOf(rep),
      });
    } else {
      members.forEach((member, idx) => {
        result.push({
          asset: member,
          stackId,
          stackCount: members.length,
          stackMemberIds: memberIds,
          isRepresentative: member.id === rep.id,
          isStackExpanded: true,
          memberIndex: idx,
        });
      });
    }
  }
  return result;
}
