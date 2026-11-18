import {collectRelations} from './relations.mjs';

export async function collect(client,previous=[]){
  const document=await client('/bill');
  const standalone=[{id:document.carrier+':'+document.leg+':'+document.billId,...document}];
  const relational=await collectRelations(client,previous,{carrier:document.carrier});
  return [...standalone,...relational];
}
