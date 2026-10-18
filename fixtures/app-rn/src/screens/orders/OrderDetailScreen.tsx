import React, { useEffect, useState } from 'react';
import { Button, Text, View } from 'react-native';
import * as orderApi from '../../api/orderApi';

export default function OrderDetailScreen({ route, navigation }) {
  const [order, setOrder] = useState(null);
  useEffect(() => {
    orderApi.getOrder(route.params.id).then(setOrder);
  }, []);

  async function onCancel() {
    await orderApi.cancel(route.params.id);
    navigation.goBack();
  }

  return (
    <View>
      <Text>{order?.status}</Text>
      <Button title="주문 취소" onPress={onCancel} />
    </View>
  );
}
