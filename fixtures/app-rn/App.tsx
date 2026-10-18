import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import MainTabs from './src/navigation/MainTabs';
import ProductDetailScreen from './src/screens/ProductDetailScreen';
import NoticeScreen from './src/screens/NoticeScreen';
import { init } from './src/db/cartDb';

const Stack = createNativeStackNavigator();

export default function App() {
  React.useEffect(() => {
    init();
  }, []);
  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
        <Stack.Screen name="ProductDetail" component={ProductDetailScreen} options={{ title: '상품 상세' }} />
        <Stack.Screen name="Notice" component={NoticeScreen} options={{ title: '공지사항' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
