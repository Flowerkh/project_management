import React from 'react';
import { Text } from 'react-native';

export default function OrderRow({ order }) {
  return <Text>{order.id}</Text>;
}
