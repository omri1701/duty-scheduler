import test from 'node:test';
import assert from 'node:assert/strict';
import {todayIsrael,millisecondsUntilIsraelMidnight} from '../lib/rota/calendar-dates.ts';

test('Israel date changes at local midnight, independently of UTC and after 09:00',()=>{
  assert.equal(todayIsrael(new Date('2026-10-17T20:59:59.999Z')),'2026-10-17');
  assert.equal(todayIsrael(new Date('2026-10-17T21:00:00Z')),'2026-10-18');
  assert.equal(todayIsrael(new Date('2026-10-18T20:00:00Z')),'2026-10-18');
});

test('next-midnight timer follows Israel DST rather than a fixed UTC offset',()=>{
  for(const instant of ['2026-03-26T22:01:00Z','2026-10-24T21:01:00Z','2026-10-17T20:59:59Z']) {
    const now=new Date(instant),wait=millisecondsUntilIsraelMidnight(now);
    assert.equal(todayIsrael(new Date(+now+wait-1)),todayIsrael(now));
    assert.notEqual(todayIsrael(new Date(+now+wait)),todayIsrael(now));
    assert.ok(wait>0 && wait<=25*3600000);
  }
  assert.equal(millisecondsUntilIsraelMidnight(new Date('2026-10-17T20:59:59Z')),1000);
});
