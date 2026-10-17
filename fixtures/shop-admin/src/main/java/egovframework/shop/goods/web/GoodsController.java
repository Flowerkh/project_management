package egovframework.shop.goods.web;

import javax.annotation.Resource;
import org.springframework.stereotype.Controller;
import org.springframework.ui.ModelMap;
import org.springframework.web.bind.annotation.*;
import egovframework.shop.goods.service.GoodsService;
import egovframework.shop.goods.service.GoodsVO;

@Controller
@RequestMapping("/goods")
public class GoodsController {

    @Resource(name = "goodsservice")
    private GoodsService goodsservice;

    /** 상품 목록 화면 */
    @RequestMapping("/goodsList.do")
    public String goodsList(@ModelAttribute("searchVO") GoodsVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectGoodsList", goodsservice.selectGoodsList(vo));
        return "shop/goods/goodsList";
    }

    /** 상품 상세 화면 */
    @RequestMapping("/goodsDetail.do")
    public String goodsDetail(@ModelAttribute("searchVO") GoodsVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectGoods", goodsservice.selectGoods(vo));
        model.addAttribute("selectGoodsOptionList", goodsservice.selectGoodsOptionList(vo));
        model.addAttribute("selectGoodsImgList", goodsservice.selectGoodsImgList(vo));
        return "shop/goods/goodsDetail";
    }

    /** 상품 등록 화면 */
    @RequestMapping("/goodsRegist.do")
    public String goodsRegist(@ModelAttribute("searchVO") GoodsVO vo, ModelMap model) throws Exception {
        return "shop/goods/goodsRegist";
    }

    /** 상품 등록 저장 */
    @RequestMapping(value = "/goodsRegistSave.do", method = RequestMethod.POST)
    public String goodsRegistSave(@ModelAttribute GoodsVO vo) throws Exception {
        goodsservice.insertGoods(vo);
        goodsservice.insertGoodsOption(vo);
        goodsservice.insertStock(vo);
        return "redirect:/goods/goodsList.do";
    }

    /** 카테고리 관리 화면 */
    @RequestMapping("/categoryList.do")
    public String categoryList(@ModelAttribute("searchVO") GoodsVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectCategoryList", goodsservice.selectCategoryList(vo));
        return "shop/goods/categoryList";
    }

    /** 카테고리 관리: insertCategory (ajax) */
    @RequestMapping(value = "/insertCategory.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> insertCategory(GoodsVO vo) throws Exception {
        goodsservice.insertCategory(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 카테고리 관리: deleteCategory (ajax) */
    @RequestMapping(value = "/deleteCategory.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> deleteCategory(GoodsVO vo) throws Exception {
        goodsservice.deleteCategory(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 재고 현황 화면 */
    @RequestMapping("/stockList.do")
    public String stockList(@ModelAttribute("searchVO") GoodsVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectStockList", goodsservice.selectStockList(vo));
        return "shop/goods/stockList";
    }

    /** 재고 현황: updateStock (ajax) */
    @RequestMapping(value = "/updateStock.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> updateStock(GoodsVO vo) throws Exception {
        goodsservice.updateStock(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

}
