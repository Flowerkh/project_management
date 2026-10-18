import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { OrderListScreen, OrderDetailScreen } from '../screens';

const Stack = createNativeStackNavigator();

const OrdersStack = () => (
  <Stack.Navigator>
    <Stack.Screen name="OrderList" component={OrderListScreen} options={{ title: '주문 내역' }} />
    <Stack.Screen name="OrderDetail" component={OrderDetailScreen} options={{ title: '주문 상세' }} />
  </Stack.Navigator>
);

export default OrdersStack;
