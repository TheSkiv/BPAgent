async function run(data) {
  console.log(`kipisTest: starting with value="${data.value}"...`);
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log(`kipisTest: test action executed with: ${data.value}`);
}

module.exports = { run };
