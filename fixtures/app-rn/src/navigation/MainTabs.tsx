import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import HomeScreen from '../screens/HomeScreen';
import CartScreen from '../screens/CartScreen';
import OrdersStack from './OrdersStack';

const Tab = createBottomTabNavigator();

export default function MainTabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Home" component={HomeScreen} options={{ title: '홈' }} />
      <Tab.Screen name="Orders" component={OrdersStack} options={{ tabBarLabel: '주문', headerShown: false }} />
      <Tab.Screen name="Cart" component={CartScreen} options={{ tabBarLabel: '장바구니' }} />
    </Tab.Navigator>
  );
}
