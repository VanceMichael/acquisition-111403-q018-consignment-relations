export async function collect(client) {
 const document=await client("/bill");
 return [{id:document.carrier+':'+document.leg+':'+document.billId,...document}];
}
