import client from './client';

export async function getOrders() {
  const res = await client.get('/orders');
  return res.data;
}

export async function getOrder(id: number) {
  const res = await client.get(`/orders/${id}`);
  return res.data;
}

export const cancel = (id: number) => client.delete(`/orders/${id}`);

export function create(items: unknown[]) {
  return client.post('/orders', { items });
}
