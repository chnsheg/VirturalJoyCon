function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function computeLayoutMetrics({ width, height }) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const aspectRatio = safeWidth / safeHeight;
  const compactLayout = safeHeight < 460 || (safeHeight < 560 && aspectRatio > 1.7);
  const ultraCompact = safeHeight < 410;

  const stickSize = clamp(
    Math.round(Math.min(safeWidth * (compactLayout ? 0.165 : 0.205), safeHeight * (compactLayout ? 0.36 : 0.48))),
    ultraCompact ? 122 : 140,
    compactLayout ? 156 : 228,
  );
  const faceSize = clamp(
    Math.round(Math.min(safeWidth * (compactLayout ? 0.058 : 0.07), safeHeight * (compactLayout ? 0.155 : 0.19))),
    ultraCompact ? 42 : 48,
    compactLayout ? 64 : 86,
  );
  const smallSize = clamp(
    Math.round(Math.min(safeWidth * (compactLayout ? 0.04 : 0.05), safeHeight * (compactLayout ? 0.115 : 0.15))),
    ultraCompact ? 32 : 36,
    compactLayout ? 48 : 62,
  );
  const metaSize = clamp(Math.round(smallSize * 0.88), 30, compactLayout ? 48 : 58);
  const shoulderWidth = clamp(
    Math.round(Math.min(safeWidth * (compactLayout ? 0.102 : 0.1), safeHeight * 0.25)),
    78,
    compactLayout ? 104 : 118,
  );
  const shoulderHeight = clamp(
    Math.round(Math.min(safeWidth * (compactLayout ? 0.045 : 0.048), safeHeight * 0.11)),
    28,
    compactLayout ? 42 : 50,
  );
  const triggerWidth = clamp(
    Math.round(Math.min(safeWidth * (compactLayout ? 0.04 : 0.045), safeHeight * 0.12)),
    34,
    compactLayout ? 48 : 60,
  );
  const triggerHeight = clamp(
    Math.round(Math.min(safeWidth * (compactLayout ? 0.1 : 0.14), safeHeight * (compactLayout ? 0.29 : 0.38))),
    92,
    compactLayout ? 118 : 184,
  );
  const gapX = clamp(
    Math.round(Math.min(safeWidth * (compactLayout ? 0.013 : 0.016), safeHeight * (compactLayout ? 0.026 : 0.04))),
    6,
    compactLayout ? 14 : 22,
  );
  const gapY = clamp(
    Math.round(Math.min(safeHeight * (compactLayout ? 0.02 : 0.03), safeWidth * (compactLayout ? 0.01 : 0.012))),
    6,
    compactLayout ? 12 : 18,
  );
  const padTop = compactLayout ? 14 : 30;

  return {
    layoutMode: compactLayout ? "compact" : "regular",
    stickSize,
    faceSize,
    smallSize,
    metaSize,
    shoulderWidth,
    shoulderHeight,
    triggerWidth,
    triggerHeight,
    gapX,
    gapY,
    padTop,
    leftMetaColumn: compactLayout ? "3" : "2",
    rightMetaColumn: compactLayout ? "4" : "5",
    leftMetaRow: compactLayout ? "2" : "3",
    rightMetaRow: compactLayout ? "2" : "3",
    triggerLabelSideOffset: compactLayout ? "calc(100% + 8px)" : "calc(100% + 10px)",
    faceClusterScale: compactLayout ? 2.48 : 2.42,
  };
}
