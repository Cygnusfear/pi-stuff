/**
 * DCP (Dynamic Context Pruning) Configuration
 * 
 * This file configures the pi-dcp extension for intelligent context pruning.
 * 
 * Place this file as:
 * - ./dcp.config.ts (project-specific configuration)
 * - ~/.dcprc (user-wide configuration)
 * 
 * All fields are optional - defaults will be used for missing values.
 */

import type { DcpConfig } from "~/.pi/agent/extensions/pi-dcp/src/types";

export default {
	// Enable/disable DCP entirely
	enabled: true,

	// Enable debug logging to see what gets pruned
	debug: false,

	// Rules to apply (in order of execution)
	// Available built-in rules:
	// - "deduplication": Remove duplicate tool outputs
	// - "superseded-writes": Remove older file versions
	// - "error-purging": Remove resolved errors
	// - "tool-pairing": Preserve tool_use/tool_result pairing (CRITICAL)
	// - "recency": Always keep recent messages
	rules: [
		"deduplication",
		"superseded-writes",
		"error-purging",
		"tool-pairing",
		"recency",
	],

	// Number of recent messages to always keep (for recency rule)
	keepRecentCount: 10,
} satisfies DcpConfig;
