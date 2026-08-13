// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stores an original SHA-256 digest only; no medical data is on-chain.
contract DocumentRegistry {
    struct Document { bytes32 hash; uint256 timestamp; address uploader; }
    mapping(string => Document) private documents;
    event DocumentRegistered(string indexed documentId, bytes32 indexed documentHash, address indexed uploader, uint256 timestamp);

    function registerDocument(string calldata documentId, bytes32 documentHash) external {
        require(bytes(documentId).length > 0, "Document ID is required");
        require(documentHash != bytes32(0), "Document hash is required");
        require(documents[documentId].timestamp == 0, "Document already registered");
        documents[documentId] = Document(documentHash, block.timestamp, msg.sender);
        emit DocumentRegistered(documentId, documentHash, msg.sender, block.timestamp);
    }

    function getDocumentHash(string calldata documentId) external view returns (bytes32) { return documents[documentId].hash; }

    function getDocument(string calldata documentId) external view returns (bytes32 hash, uint256 timestamp, address uploader) {
        Document memory document = documents[documentId];
        return (document.hash, document.timestamp, document.uploader);
    }
}
