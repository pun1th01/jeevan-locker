// Deploys both registries and prints the two .env lines. On a fresh `hardhat node` the addresses are
// deterministic (first two deployments from account #0), but always copy what this prints.
const hre = require('hardhat');

async function main() {
  const DocumentRegistry = await hre.ethers.getContractFactory('DocumentRegistry');
  const registry = await DocumentRegistry.deploy();
  await registry.waitForDeployment();

  const AuditAnchorRegistry = await hre.ethers.getContractFactory('AuditAnchorRegistry');
  const anchors = await AuditAnchorRegistry.deploy();
  await anchors.waitForDeployment();

  console.log(`DOCUMENT_REGISTRY_ADDRESS=${await registry.getAddress()}`);
  console.log(`AUDIT_ANCHOR_ADDRESS=${await anchors.getAddress()}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
