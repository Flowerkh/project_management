import React from 'react';
import { Button, View } from 'react-native';
import * as cartDb from '../db/cartDb';
import { productApi } from '../api/productApi';

const ProductDetailScreen = ({ route }) => {
  const { id } = route.params;
  const [product, setProduct] = React.useState(null);
  React.useEffect(() => {
    productApi.get(id).then((r) => setProduct(r.data));
  }, [id]);
  const addToCart = () => {
    cartDb.addItem(id, 1);
  };
  return (
    <View>
      <Button title="장바구니 담기" onPress={addToCart} />
    </View>
  );
};

export default ProductDetailScreen;
