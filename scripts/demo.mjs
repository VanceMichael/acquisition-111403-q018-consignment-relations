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
  const receipt=await response.json();
  if(!response.ok)throw new Error(JSON.stringify(receipt));
  return receipt;
};
try{
  console.log('首次接收',JSON.stringify(await collect()));
  source.setPhase('regroup');
  console.log('合票修订后接收',JSON.stringify(await collect()));
  source.setPhase('missing-load');
  console.log('箱单补发中接收',JSON.stringify(await collect()));
  console.log('结构化资料',JSON.stringify(await(await fetch(intake.origin+'/records')).json(),null,2));
  console.log('未决原因',JSON.stringify(await(await fetch(intake.origin+'/pending')).json(),null,2));
  console.log('原文凭据',JSON.stringify(await(await fetch(intake.origin+'/receipts')).json(),null,2));
}finally{await intake.close();await source.close();await rm(directory,{recursive:true,force:true});}
