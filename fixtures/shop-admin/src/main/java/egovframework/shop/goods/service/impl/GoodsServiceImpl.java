package egovframework.shop.goods.service.impl;

import javax.annotation.Resource;
import org.springframework.stereotype.Service;
import egovframework.rte.fdl.cmmn.EgovAbstractServiceImpl;
import egovframework.shop.goods.service.GoodsService;
import egovframework.shop.goods.service.GoodsVO;

@Service("goodsservice")
public class GoodsServiceImpl extends EgovAbstractServiceImpl implements GoodsService {

    @Resource(name = "goodsdao")
    private GoodsDAO goodsdao;

    @Override
    public Object selectGoodsList(GoodsVO vo) throws Exception {
        return goodsdao.selectGoodsList(vo);
    }

    @Override
    public Object selectGoods(GoodsVO vo) throws Exception {
        return goodsdao.selectGoods(vo);
    }

    @Override
    public Object selectGoodsOptionList(GoodsVO vo) throws Exception {
        return goodsdao.selectGoodsOptionList(vo);
    }

    @Override
    public Object selectGoodsImgList(GoodsVO vo) throws Exception {
        return goodsdao.selectGoodsImgList(vo);
    }

    @Override
    public Object insertGoods(GoodsVO vo) throws Exception {
        return goodsdao.insertGoods(vo);
    }

    @Override
    public Object insertGoodsOption(GoodsVO vo) throws Exception {
        return goodsdao.insertGoodsOption(vo);
    }

    @Override
    public Object insertStock(GoodsVO vo) throws Exception {
        return goodsdao.insertStock(vo);
    }

    @Override
    public Object selectCategoryList(GoodsVO vo) throws Exception {
        return goodsdao.selectCategoryList(vo);
    }

    @Override
    public Object insertCategory(GoodsVO vo) throws Exception {
        return goodsdao.insertCategory(vo);
    }

    @Override
    public Object deleteCategory(GoodsVO vo) throws Exception {
        return goodsdao.deleteCategory(vo);
    }

    @Override
    public Object selectStockList(GoodsVO vo) throws Exception {
        return goodsdao.selectStockList(vo);
    }

    @Override
    public Object updateStock(GoodsVO vo) throws Exception {
        return goodsdao.updateStock(vo);
    }

}
