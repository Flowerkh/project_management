import React, { useEffect, useState } from 'react';
import { FlatList, Text, TouchableOpacity } from 'react-native';
import { productApi } from '../api/productApi';

export default function HomeScreen({ navigation }) {
  const [products, setProducts] = useState([]);
  useEffect(() => {
    productApi.list().then((res) => setProducts(res.data));
  }, []);
  return (
    <FlatList
      data={products}
      renderItem={({ item }) => (
        <TouchableOpacity onPress={() => navigation.navigate('ProductDetail', { id: item.id })}>
          <Text>{item.name}</Text>
        </TouchableOpacity>
      )}
    />
  );
}
