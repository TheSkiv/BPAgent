const { openKipis, getPage } = require('./core/browser');
const { navigateToCargo }    = require('../KIPIS_skills/PRK/navigateToCargo');

async function main() {
  await openKipis();
  const page = getPage();
  await navigateToCargo(page, { plate: 'GJO627//GM923' });
  console.log('Done.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
