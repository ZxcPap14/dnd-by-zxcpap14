import mqtt from 'mqtt';
const url = process.env.BROKER || 'wss://broker.emqx.io:8084/mqtt';
const c = mqtt.connect(url, { clientId: 'size-test-' + Math.random().toString(16).slice(2) });
c.on('connect', async () => {
  console.log('connected');
  for (const n of [200, 1000, 3000, 5000, 10000, 50000]) {
    await new Promise(r => c.publish('dndzxc14/v2/size/' + Math.random().toString(16).slice(2), 'x'.repeat(n), { qos: 1 }, e => { console.log('pub', n, e ? 'ERR ' + e.message : 'ok'); r(); }));
  }
  setTimeout(() => { console.log('still connected:', c.connected); c.end(true); }, 2000);
});
c.on('close', () => console.log('closed'));
c.on('offline', () => console.log('offline'));
c.on('error', e => console.log('error', e.message));
