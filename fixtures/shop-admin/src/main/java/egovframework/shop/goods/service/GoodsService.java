package egovframework.shop.goods.service;

import java.util.List;
import egovframework.rte.psl.dataaccess.util.EgovMap;

public interface GoodsService {
    Object selectGoodsList(GoodsVO vo) throws Exception;
    Object selectGoods(GoodsVO vo) throws Exception;
    Object selectGoodsOptionList(GoodsVO vo) throws Exception;
    Object selectGoodsImgList(GoodsVO vo) throws Exception;
    Object insertGoods(GoodsVO vo) throws Exception;
    Object insertGoodsOption(GoodsVO vo) throws Exception;
    Object insertStock(GoodsVO vo) throws Exception;
    Object selectCategoryList(GoodsVO vo) throws Exception;
    Object insertCategory(GoodsVO vo) throws Exception;
    Object deleteCategory(GoodsVO vo) throws Exception;
    Object selectStockList(GoodsVO vo) throws Exception;
    Object updateStock(GoodsVO vo) throws Exception;
}
