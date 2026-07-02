const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzePlaylistObfuscation } = require('../src/utils/playlistAnalysis');

function buildTitleLines({
  titleId,
  playlistId,
  duration = '01:34:41',
  chapters = 20,
  audioTrackCount = 3,
  subtitleTrackCount = 2,
  segmentNumbers = []
}) {
  const lines = [
    `MSG:3016,0,0,"${playlistId}.mpls","${titleId}"`,
    `TINFO:${titleId},16,0,"${playlistId}.mpls"`,
    `TINFO:${titleId},9,0,"${duration}"`,
    `TINFO:${titleId},8,0,"${chapters}"`,
    `TINFO:${titleId},26,0,"${segmentNumbers.join(', ')}"`
  ];

  for (let index = 0; index < audioTrackCount; index += 1) {
    lines.push(`SINFO:${titleId},${index},1,0,"Audio"`);
    lines.push(`SINFO:${titleId},${index},3,0,"eng"`);
    lines.push(`SINFO:${titleId},${index},4,0,"English"`);
    lines.push(`SINFO:${titleId},${index},6,0,"DTS-HD MA"`);
    lines.push(`SINFO:${titleId},${index},40,0,"5.1 ch"`);
  }

  for (let index = 0; index < subtitleTrackCount; index += 1) {
    const streamIndex = audioTrackCount + index;
    lines.push(`SINFO:${titleId},${streamIndex},1,0,"Subtitle"`);
    lines.push(`SINFO:${titleId},${streamIndex},3,0,"eng"`);
    lines.push(`SINFO:${titleId},${streamIndex},4,0,"English"`);
    lines.push(`SINFO:${titleId},${streamIndex},6,0,"PGS"`);
  }

  return lines;
}

test('branching cluster prefers the structurally simplest reference playlist', () => {
  const lines = [
    ...buildTitleLines({
      titleId: 0,
      playlistId: '00802',
      segmentNumbers: [
        866, 868, 829, 848, 830, 849, 831, 850, 832, 851,
        833, 852, 834, 853, 835, 854, 869, 870, 872, 855,
        837, 856, 838, 857, 839, 858, 840, 859, 841, 860,
        842, 861, 843, 862, 844, 863, 845, 864, 846
      ]
    }),
    ...buildTitleLines({
      titleId: 1,
      playlistId: '00800',
      segmentNumbers: [
        847, 829, 848, 830, 849, 831, 850, 832, 851, 833,
        852, 834, 853, 835, 854, 836, 855, 837, 856, 838,
        857, 839, 858, 840, 859, 841, 860, 842, 861, 843,
        862, 844, 863, 845, 864, 846
      ]
    }),
    ...buildTitleLines({
      titleId: 3,
      playlistId: '00804',
      segmentNumbers: [
        867, 868, 829, 848, 830, 849, 831, 850, 832, 851,
        833, 852, 834, 853, 835, 854, 869, 871, 872, 855,
        837, 856, 838, 857, 839, 858, 840, 859, 841, 860,
        842, 861, 843, 862, 844, 863, 845, 864, 846
      ]
    })
  ];

  const analysis = analyzePlaylistObfuscation(lines, 60, {
    durationSimilaritySeconds: 90
  });

  assert.equal(analysis?.recommendation?.playlistId, '00800');
  assert.deepEqual(
    (analysis?.evaluatedCandidates || []).map((item) => item.playlistId),
    ['00800', '00804', '00802']
  );
  assert.deepEqual(analysis?.candidatePlaylists || [], ['00800', '00804', '00802']);

  const preferred = (analysis?.evaluatedCandidates || [])[0];
  assert.equal(preferred?.recommended, true);
  assert.equal(preferred?.evaluationLabel, 'strukturell sauberster Basis-/Referenzpfad im Branching-Cluster');

  const variantSummary = (preferred?.variantSpans || []).map((span) => ({
    before: span.beforeSegment,
    after: span.afterSegment,
    segments: span.segments
  }));
  assert.deepEqual(variantSummary, [
    { before: null, after: 829, segments: [847] },
    { before: 854, after: 855, segments: [836] }
  ]);
});
