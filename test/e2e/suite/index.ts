import Mocha from 'mocha';
import * as path from 'path';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', timeout: 120000, color: true });
  mocha.addFile(path.join(__dirname, 'acceptance.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run(failures => (failures ? reject(new Error(`${failures} tests failed`)) : resolve()));
  });
}
