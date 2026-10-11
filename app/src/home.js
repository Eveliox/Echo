export function homeStatus(vm) {
 if(!vm.online)return vm.status?'Connection lost':'Waiting for readings';
 return {EMERGENCY:'Go to the car now',WARNING:'Cabin warming',OCCUPANT:'Seat occupied',ARMED:'Monitoring',IDLE:'Monitoring'}[vm.status?.state] || 'Waiting for readings';
}
export function closestReading(points, x) {
 if(!points.length || !Number.isFinite(x))return null;
 return points.reduce((a,b)=>Math.abs(b.x-x)<Math.abs(a.x-x)?b:a);
}

export function parentGuidance(vm) {
 if (vm.lostAlarm) return { urgent: true, title: 'Check your child now', detail: `The last reading reported ${vm.status?.state === 'EMERGENCY' ? 'an emergency' : 'a heat warning'}. We have lost contact with the car.` };
 if (vm.emergency) return { urgent: true, title: 'Dangerous heat reported', detail: 'Check your child immediately.' };
 if (!vm.online) return vm.status
  ? { urgent: true, title: 'Check the car in person', detail: 'We cannot confirm the current temperature or seat occupancy.' }
  : { urgent: false, title: 'Waiting to connect', detail: 'Keep your Echo device powered and connected. Your first reading will appear here.' };
 if (vm.status?.state === 'WARNING') return { urgent: true, title: 'Check your child now', detail: 'The cabin is warming. Go back to the car if you have stepped away.' };
 if (vm.status?.presence === true) return { urgent: false, title: 'Someone is in the seat', detail: 'Stay with your child. Echo is monitoring the cabin temperature.' };
 return { urgent: false, title: 'Before you leave the car', detail: 'Check the back seat and take your child with you.' };
}

export function dangerEstimate(vm) {
 const value = vm.status?.minsToDanger;
 return { label: vm.online ? 'Estimated time to dangerous heat' : 'Last recorded heat estimate', value: value == null ? 'No estimate' : value === 0 ? 'Danger level reached' : `${value} min` };
}

export function carMotionAllowed({ online, visible, active, reduced, paused, emergency }) {
 return online && visible && active && !reduced && !paused && !emergency;
}

export function sceneVisible(bounds, offset, height) {
 return height > 0 && bounds.height > 0 && offset < bounds.y + bounds.height && offset + height > bounds.y;
}
