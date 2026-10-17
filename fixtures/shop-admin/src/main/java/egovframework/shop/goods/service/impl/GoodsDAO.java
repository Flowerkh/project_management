package egovframework.shop.goods.service.impl;

import java.util.List;
import org.springframework.stereotype.Repository;
import egovframework.rte.psl.dataaccess.EgovAbstractMapper;
import egovframework.shop.goods.service.GoodsVO;

@Repository("goodsdao")
public class GoodsDAO extends EgovAbstractMapper {

    public Object selectGoodsList(GoodsVO vo) throws Exception {
        return selectList("goodsdao.selectGoodsList", vo);
    }

    public Object selectGoods(GoodsVO vo) throws Exception {
        return selectOne("goodsdao.selectGoods", vo);
    }

    public Object selectGoodsOptionList(GoodsVO vo) throws Exception {
        return selectList("goodsdao.selectGoodsOptionList", vo);
    }

    public Object selectGoodsImgList(GoodsVO vo) throws Exception {
        return selectList("goodsdao.selectGoodsImgList", vo);
    }

    public Object insertGoods(GoodsVO vo) throws Exception {
        return insert("goodsdao.insertGoods", vo);
    }

    public Object insertGoodsOption(GoodsVO vo) throws Exception {
        return insert("goodsdao.insertGoodsOption", vo);
    }

    public Object insertStock(GoodsVO vo) throws Exception {
        return insert("goodsdao.insertStock", vo);
    }

    public Object selectCategoryList(GoodsVO vo) throws Exception {
        return selectList("goodsdao.selectCategoryList", vo);
    }

    public Object insertCategory(GoodsVO vo) throws Exception {
        return insert("goodsdao.insertCategory", vo);
    }

    public Object deleteCategory(GoodsVO vo) throws Exception {
        return delete("goodsdao.deleteCategory", vo);
    }

    public Object selectStockList(GoodsVO vo) throws Exception {
        return selectList("goodsdao.selectStockList", vo);
    }

    public Object updateStock(GoodsVO vo) throws Exception {
        return update("goodsdao.updateStock", vo);
    }

}
