const hre = require('hardhat');

async function main() {
  const DocumentRegistry = await hre.ethers.getContractFactory('DocumentRegistry');
  const registry = await DocumentRegistry.deploy();
  await registry.waitForDeployment();
  console.log(`DOCUMENT_REGISTRY_ADDRESS=${await registry.getAddress()}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
