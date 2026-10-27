// Parameterized replaceable kinds (30000-39999) hold state that changes over time;
// regular kinds (1000-9999) are append-only records.
export const KIND_GROUP = 38700;
export const KIND_JOIN = 8701;
export const KIND_ROUND = 38702;
export const KIND_RECEIPT = 8703;
// A member's opt-in for the coordinator to pay on their behalf; replaceable per member and group.
export const KIND_AUTOPAY = 38704;
// A member's question for the group assistant, the assistant's answer, and its reminders. Each is
// encrypted between the member and the coordinator, so other members can't read them.
export const KIND_ASK = 8705;
export const KIND_ANSWER = 8706;
export const KIND_NOTICE = 8707;
// A request to join a group that is still forming, encrypted to the organizer.
export const KIND_REQUEST = 8708;
