export interface Game {
  name: string;
  url: string;
  description: string;
}

export interface DayPass {
  unicityId: string;
  grantedAt: number;
  expiresAt: number;
}

export interface PaymentRequest {
  requestId: string;
  unicityId: string;
  amount: bigint;
  createdAt: number;
}
