// Parameterized replaceable kinds (30000-39999) hold state that changes over time;
// regular kinds (1000-9999) are append-only records.
export const KIND_GROUP = 38700;
export const KIND_JOIN = 8701;
export const KIND_ROUND = 38702;
export const KIND_RECEIPT = 8703;
// A member's opt-in for the coordinator to pay on their behalf; replaceable per member and group.
export const KIND_AUTOPAY = 38704;
