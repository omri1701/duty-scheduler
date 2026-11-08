import test from 'node:test';
import assert from 'node:assert/strict';
import {verticalInsertion,reorderOffsets} from '../lib/rota/drag-presentation.ts';

const rows=[{top:10,bottom:50,height:40},{top:58,bottom:138,height:80},{top:150,bottom:180,height:30},{top:185,bottom:245,height:60}];
test('insertion crosses measured midpoints, including gaps and several positions',()=>{
 assert.equal(verticalInsertion(rows,0,97),0);
 assert.equal(verticalInsertion(rows,0,98),1);
 assert.equal(verticalInsertion(rows,0,149),1);
 assert.equal(verticalInsertion(rows,0,215),3);
 assert.equal(verticalInsertion(rows,3,99),2);
 assert.equal(verticalInsertion(rows,3,30),0);
});
test('preview respects unequal row heights and unequal slot gaps in either direction',()=>{
 assert.deepEqual(reorderOffsets(rows,0,3),[195,-48,-52,-45]);
 assert.deepEqual(reorderOffsets(rows,3,0),[68,72,65,-175]);
 assert.deepEqual(reorderOffsets(rows,1,2),[0,42,-92,0]);
 assert.deepEqual(reorderOffsets(rows,2,1),[0,42,-92,0]);
 assert.deepEqual(reorderOffsets(rows,2,2),[0,0,0,0]);
});
