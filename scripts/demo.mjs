import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startSource} from '../provider/server.mjs';
import {startIntake} from '../src/app.mjs';

const directory=await mkdtemp(join(tmpdir(),'intake-demo-'));
const source=await startSource();
const intake=await startIntake({origin:source.origin,directory});
const collect=async()=>{
 const response=await fetch(intake.origin+'/collect',{method:'POST'});
 const receipt=await response.json();if(!response.ok)throw new Error(JSON.stringify(receipt));
 return receipt;
};
const show=async label=>{
 console.log(`\n== ${label} ==`);
 console.log('当前关系',JSON.stringify(await(await fetch(intake.origin+'/relations')).json(),null,2));
 console.log('未决事项',JSON.stringify(await(await fetch(intake.origin+'/pending')).json(),null,2));
};
try{
 console.log('分票接收',JSON.stringify(await collect()));await show('分票后');
 source.setPhase('regroup');
 console.log('\n合票修订接收',JSON.stringify(await collect()));await show('合票修订后');
 source.setPhase('missing-load');
 console.log('\n箱单缺失接收',JSON.stringify(await collect()));await show('箱单缺失时');
 source.setPhase('normal');
 console.log('\n补收',JSON.stringify(await collect()));await show('补收后');
 console.log('\n结构化资料',JSON.stringify(await(await fetch(intake.origin+'/records')).json(),null,2));
 console.log('原文凭据',JSON.stringify(await(await fetch(intake.origin+'/receipts')).json(),null,2));
}finally{await intake.close();await source.close();await rm(directory,{recursive:true,force:true});}
