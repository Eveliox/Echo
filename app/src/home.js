export function homeStatus(vm) {
 if(!vm.online)return vm.status?'Connection lost':'Waiting for readings';
 return {EMERGENCY:'Go to the car now',WARNING:'Cabin warming',OCCUPANT:'Seat occupied',ARMED:'Monitoring',IDLE:'Monitoring'}[vm.status?.state] || 'Waiting for readings';
}
export function closestReading(points, x) {
 if(!points.length || !Number.isFinite(x))return null;
 return points.reduce((a,b)=>Math.abs(b.x-x)<Math.abs(a.x-x)?b:a);
}
