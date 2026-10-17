package egovframework.shop.order.batch;

import javax.annotation.Resource;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import egovframework.shop.order.service.OrderService;

/** 주문 자동 확정: 배송 완료 후 7일 지난 주문을 구매 확정 */
@Component
public class OrderAutoConfirmJob {

    @Resource(name = "orderService")
    private OrderService orderService;

    @Scheduled(cron = "0 0 3 * * *")
    public void autoConfirm() throws Exception {
        orderService.updateOrderStat(null);
        orderService.insertOrderHist(null);
    }
}
