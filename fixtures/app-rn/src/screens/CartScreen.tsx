import React, { useEffect, useState } from 'react';
import { Button, View } from 'react-native';
import * as cartDb from '../db/cartDb';
import { create } from '../api/orderApi';

export default function CartScreen() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    cartDb.getItems().then(setItems);
  }, []);

  const checkout = async () => {
    await create(items);
    cartDb.clear();
  };

  return (
    <View>
      <Button title="주문하기" onPress={checkout} />
    </View>
  );
}
