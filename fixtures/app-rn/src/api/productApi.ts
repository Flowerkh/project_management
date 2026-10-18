import client from './client';

export const productApi = {
  list: () => client.get('/products'),
  get: (id: number) => client.get(`/products/${id}`),
};
