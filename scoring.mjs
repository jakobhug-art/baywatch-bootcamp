export function exercisePoints({target,step,goalPoints},amount){
 const reached=Math.min(amount,target);
 const extra=Math.min(Math.max(amount-target,0),target);
 if(!goalPoints) return Math.floor(reached/step)+Math.floor(extra/(4*step));
 const base=Math.floor(reached*goalPoints/target);
 const bonus=Math.floor(extra*goalPoints/(4*target));
 return Math.min(75,base+bonus);
}
