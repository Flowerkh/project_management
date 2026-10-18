import React from 'react';
import { FlatList } from 'react-native';
import { useOrders } from '../../hooks/useOrders';
import OrderRow from '../../components/OrderRow';

export default function OrderListScreen() {
  const orders = useOrders();
  return <FlatList data={orders} renderItem={({ item }) => <OrderRow order={item} />} />;
}
