package egovframework.shop.order.web;

import javax.annotation.Resource;
import org.springframework.stereotype.Controller;
import org.springframework.ui.ModelMap;
import org.springframework.web.bind.annotation.*;
import egovframework.shop.order.service.OrderService;
import egovframework.shop.order.service.OrderVO;

@Controller
@RequestMapping("/order")
public class OrderController {

    @Resource(name = "orderservice")
    private OrderService orderservice;

    /** 주문 목록 화면 */
    @RequestMapping("/orderList.do")
    public String orderList(@ModelAttribute("searchVO") OrderVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectOrderList", orderservice.selectOrderList(vo));
        return "shop/order/orderList";
    }

    /** 주문 상세 화면 */
    @RequestMapping("/orderDetail.do")
    public String orderDetail(@ModelAttribute("searchVO") OrderVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectOrder", orderservice.selectOrder(vo));
        model.addAttribute("selectOrderItemList", orderservice.selectOrderItemList(vo));
        model.addAttribute("selectOrderDlvy", orderservice.selectOrderDlvy(vo));
        model.addAttribute("selectPay", orderservice.selectPay(vo));
        return "shop/order/orderDetail";
    }

    /** 주문 상세: updateOrderStat (ajax) */
    @RequestMapping(value = "/updateOrderStat.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> updateOrderStat(OrderVO vo) throws Exception {
        orderservice.updateOrderStat(vo);
        orderservice.insertOrderHist(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 주문 상세: insertOrderHist (ajax) */
    @RequestMapping(value = "/insertOrderHist.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> insertOrderHist(OrderVO vo) throws Exception {
        orderservice.insertOrderHist(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 주문 상세: updateDlvyStat (ajax) */
    @RequestMapping(value = "/updateDlvyStat.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> updateDlvyStat(OrderVO vo) throws Exception {
        orderservice.updateDlvyStat(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 배송 현황 화면 */
    @RequestMapping("/dlvyList.do")
    public String dlvyList(@ModelAttribute("searchVO") OrderVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectDlvyList", orderservice.selectDlvyList(vo));
        return "shop/order/dlvyList";
    }

    /** 반품·교환 화면 */
    @RequestMapping("/claimList.do")
    public String claimList(@ModelAttribute("searchVO") OrderVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectClaimList", orderservice.selectClaimList(vo));
        return "shop/order/claimList";
    }

    /** 반품·교환: insertClaim (ajax) */
    @RequestMapping(value = "/insertClaim.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> insertClaim(OrderVO vo) throws Exception {
        orderservice.insertClaim(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 반품·교환: updateClaimStat (ajax) */
    @RequestMapping(value = "/updateClaimStat.do", method = RequestMethod.POST)
    @ResponseBody
    public java.util.Map<String, Object> updateClaimStat(OrderVO vo) throws Exception {
        orderservice.updateClaimStat(vo);
        return java.util.Collections.singletonMap("result", "OK");
    }

    /** 주문 이력 화면 */
    @RequestMapping("/orderHistPopup.do")
    public String orderHistPopup(@ModelAttribute("searchVO") OrderVO vo, ModelMap model) throws Exception {
        model.addAttribute("selectOrderHistList", orderservice.selectOrderHistList(vo));
        return "shop/order/orderHistPopup";
    }

}
