const assert = require('node:assert/strict');
const {
  impactQuantile,
  impactWarmSeason,
  impactPeriodRows,
  impactPerformance,
  impactRiskBins,
  impactThresholdDelta
} = require('../health-impact.js');

assert.equal(impactQuantile([0, 1, 2, 3, 4], 0.5), 2);
assert.equal(impactQuantile([0, 10], 0.95), 9.5);
assert.equal(impactQuantile([], 0.95), null);

const seasonRows = [
  {date:'2024-04-30'},
  {date:'2024-05-01'},
  {date:'2024-06-15'},
  {date:'2024-07-15'},
  {date:'2024-08-15'},
  {date:'2024-09-30'},
  {date:'2024-10-01'}
];
assert.deepEqual(impactWarmSeason(seasonRows).map(r=>r.date), [
  '2024-05-01','2024-06-15','2024-07-15','2024-08-15','2024-09-30'
]);
assert.equal(impactPeriodRows(impactWarmSeason(seasonRows),'early').length,2);
assert.equal(impactPeriodRows(impactWarmSeason(seasonRows),'peak').length,2);
assert.equal(impactPeriodRows(impactWarmSeason(seasonRows),'late').length,1);

const rows = [
  {date:'2024-07-01',peak_heat_index_f:102,yRate:0.1},
  {date:'2024-07-02',peak_heat_index_f:104,yRate:0.2},
  {date:'2024-07-03',peak_heat_index_f:106,yRate:1.2},
  {date:'2024-07-04',peak_heat_index_f:107,yRate:0.3},
  {date:'2024-07-05',peak_heat_index_f:108,yRate:1.4},
  {date:'2024-07-06',peak_heat_index_f:109,yRate:1.5},
  {date:'2024-07-07',peak_heat_index_f:110,yRate:0.4},
  {date:'2024-07-08',peak_heat_index_f:112,yRate:1.7}
];
const cutoff = 1.0;
const at108 = impactPerformance(rows, cutoff, 108);
assert.equal(at108.tp,3);
assert.equal(at108.fp,1);
assert.equal(at108.fn,1);
assert.equal(at108.tn,3);
assert.equal(at108.eventProbability,0.75);
assert.equal(at108.sensitivity,0.75);
assert.equal(at108.specificity,0.75);
assert.ok(at108.riskRatio > 2);
assert.ok(at108.rrLow > 0 && at108.rrHigh > at108.rrLow);

const at106 = impactPerformance(rows, cutoff, 106);
assert.equal(at106.tp,4);
assert.equal(at106.fn,0);
assert.equal(at106.sensitivity,1);
const delta106 = impactThresholdDelta(rows, cutoff, 106, 108);
assert.deepEqual(delta106,{days:2,events:1,direction:'lower'});
const delta110 = impactThresholdDelta(rows, cutoff, 110, 108);
assert.deepEqual(delta110,{days:2,events:2,direction:'higher'});

const dense = [];
for(let hi=100; hi<116; hi+=1){
  for(let i=0;i<10;i++) dense.push({date:'2024-07-01',peak_heat_index_f:hi+.1,yRate:hi>=108?2:0});
}
const bins = impactRiskBins(dense,1,2,8);
assert.ok(bins.length>=8);
assert.equal(bins.find(b=>b.lo===108).probability,1);
assert.equal(bins.find(b=>b.lo===104).probability,0);

console.log('Health-impact tests passed: percentile, season filters, threshold performance, RR interval, deltas, and HI bins.');
