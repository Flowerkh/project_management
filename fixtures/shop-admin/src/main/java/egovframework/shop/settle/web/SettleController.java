package egovframework.shop.settle.web;

import javax.annotation.Resource;
import org.springframework.stereotype.Controller;
import org.springframework.ui.ModelMap;
import org.springframework.web.bind.annotation.*;
import egovframework.shop.settle.service.SettleService;
import egovframework.shop.settle.service.SettleVO;

@Controller
@RequestMapping("/settle")
public class SettleController {

    @Resource(name = "settleservice")
    private SettleService settleservice;

    /** 정산 목록 화면 */
    @RequestMapping("/settleList.do")
    public String settleList(@ModelAttribute("searchVO") SettleVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectSettleList", settleservice.selectSettleList(vo));
        return "shop/settle/settleList";
    }

    /** 정산 상세 화면 */
    @RequestMapping("/settleDetail.do")
    public String settleDetail(@ModelAttribute("searchVO") SettleVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectSettle", settleservice.selectSettle(vo));
        model.addAttribute("selectSettleItemList", settleservice.selectSettleItemList(vo));
        return "shop/settle/settleDetail";
    }

    /** 정산 상세: updateSettleStat (ajax) */
    @RequestMapping(value = "/updateSettleStat.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> updateSettleStat(SettleVO vo) throws Exception {
        settleservice.updateSettleStat(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 판매자 관리 화면 */
    @RequestMapping("/sellerList.do")
    public String sellerList(@ModelAttribute("searchVO") SettleVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectSellerList", settleservice.selectSellerList(vo));
        return "shop/settle/sellerList";
    }

    /** 판매자 관리: insertSeller (ajax) */
    @RequestMapping(value = "/insertSeller.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> insertSeller(SettleVO vo) throws Exception {
        settleservice.insertSeller(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 월 매출 통계 화면 */
    @RequestMapping("/salesStats.do")
    public String salesStats(@ModelAttribute("searchVO") SettleVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectSalesMonthly", settleservice.selectSalesMonthly(vo));
        return "shop/settle/salesStats";
    }

}
