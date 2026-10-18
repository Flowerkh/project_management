import { useEffect, useState } from 'react';
import { getOrders } from '../api/orderApi';

export function useOrders() {
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    getOrders().then(setOrders);
  }, []);
  return orders;
}
