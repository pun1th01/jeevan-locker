// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Write-once registry of SHA-256 digests of audit events (consent transitions, emergency
///         grants). Only an opaque key and a digest are stored; no personal or medical data is on-chain.
///         The preimage of each digest lives off-chain (see docs/ANCHORING.md) and can be recomputed
///         from the database record to verify that the record still matches what was anchored.
contract AuditAnchorRegistry {
    struct Anchor { bytes32 digest; uint256 timestamp; address anchoredBy; }
    mapping(bytes32 => Anchor) private anchors;
    event Anchored(bytes32 indexed key, bytes32 indexed digest, address indexed anchoredBy, uint256 timestamp);

    /// @param key    keccak256 of the off-chain record key, e.g. "consent:<id>:APPROVED"
    /// @param digest SHA-256 of the canonical preimage for that event
    function anchor(bytes32 key, bytes32 digest) external {
        require(key != bytes32(0), "Key is required");
        require(digest != bytes32(0), "Digest is required");
        require(anchors[key].timestamp == 0, "Key already anchored");
        anchors[key] = Anchor(digest, block.timestamp, msg.sender);
        emit Anchored(key, digest, msg.sender, block.timestamp);
    }

    function getAnchor(bytes32 key) external view returns (bytes32 digest, uint256 timestamp, address anchoredBy) {
        Anchor memory a = anchors[key];
        return (a.digest, a.timestamp, a.anchoredBy);
    }
}
